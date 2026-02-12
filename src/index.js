const express = require('express')
const app = express()
const port = process.env.PORT || 3000
const bodyParser = require('body-parser')
const authToken = process.env.authToken || null
const cors = require('cors')
const reqValidate = require('./module/reqValidate')

global.browserLength = 0
global.browserLimit = Number(process.env.browserLimit) || 20
global.timeOut = Number(process.env.timeOut || 60000)

// ============================================
// 1. 全局异常捕获 - 防止进程意外退出
// ============================================
process.on('uncaughtException', (err) => {
    console.error('[uncaughtException]', err.message, err.stack)
})

process.on('unhandledRejection', (reason, promise) => {
    console.error('[unhandledRejection]', reason)
})

// ============================================
// 2. 优雅退出 - 确保浏览器实例被正确关闭
// ============================================
async function gracefulShutdown(signal) {
    console.log(`Received ${signal}, shutting down gracefully...`)
    try {
        if (global.browser) {
            await global.browser.close()
            global.browser = null
            console.log('Browser closed.')
        }
    } catch (e) {
        console.error('Error closing browser:', e.message)
    }
    process.exit(0)
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'))
process.on('SIGINT', () => gracefulShutdown('SIGINT'))

// ============================================
// 3. 限制请求体大小 - 防止大 payload 导致 OOM
// ============================================
app.use(bodyParser.json({ limit: '1mb' }))
app.use(bodyParser.urlencoded({ extended: true, limit: '1mb' }))
app.use(cors())

// ============================================
// 4. 浏览器健康检查 & 自动重启
// ============================================
async function ensureBrowser() {
    if (!global.browser) return false
    try {
        // 检查浏览器进程是否还活着
        if (!global.browser.isConnected || !global.browser.isConnected()) {
            console.warn('Browser disconnected, restarting...')
            try { await global.browser.close() } catch (_) {}
            global.browser = null
            require('./module/createBrowser')
            return false
        }
        return true
    } catch (e) {
        console.error('Browser health check failed:', e.message)
        global.browser = null
        require('./module/createBrowser')
        return false
    }
}

// ============================================
// 5. 带超时的任务执行器 - 防止任务永远挂起
// ============================================
function withTimeout(promise, ms, taskName = 'task') {
    let timer
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
            reject(new Error(`${taskName} timed out after ${ms}ms`))
        }, ms)
    })
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

if (process.env.NODE_ENV !== 'development') {
    const server = app.listen(port, () => {
        console.log(`Server running on port ${port}`)
    })
    server.timeout = global.timeOut
    // 设置 keep-alive 超时，避免连接堆积
    server.keepAliveTimeout = 65000
    server.headersTimeout = 66000
}

if (process.env.SKIP_LAUNCH !== 'true') require('./module/createBrowser')

const getSource = require('./endpoints/getSource')
const solveTurnstileMin = require('./endpoints/solveTurnstile.min')
const solveTurnstileMax = require('./endpoints/solveTurnstile.max')
const wafSession = require('./endpoints/wafSession')

// ============================================
// 6. 主路由 - 增加超时保护和安全的计数器管理
// ============================================
app.post('/cf-clearance-scraper', async (req, res) => {
    const data = req.body

    const check = reqValidate(data)
    if (check !== true) {
        return res.status(400).json({ code: 400, message: 'Bad Request', schema: check })
    }

    if (authToken && data.authToken !== authToken) {
        return res.status(401).json({ code: 401, message: 'Unauthorized' })
    }

    if (global.browserLength >= global.browserLimit) {
        return res.status(429).json({ code: 429, message: 'Too Many Requests' })
    }

    if (process.env.SKIP_LAUNCH !== 'true') {
        const browserOk = await ensureBrowser()
        if (!global.browser) {
            return res.status(500).json({
                code: 500,
                message: 'The scanner is not ready yet. Please try again a little later.'
            })
        }
    }

    let result = { code: 500, message: 'Unknown error' }

    // 使用 try/finally 确保计数器一定会递减
    global.browserLength++
    try {
        const taskTimeout = data.timeout || global.timeOut - 5000 // 留 5s 余量

        switch (data.mode) {
            case 'source':
                result = await withTimeout(
                    getSource(data),
                    taskTimeout,
                    'getSource'
                ).then(res => ({ source: res, code: 200 }))
                 .catch(err => ({ code: 500, message: err.message }))
                break

            case 'turnstile-min':
                result = await withTimeout(
                    solveTurnstileMin(data),
                    taskTimeout,
                    'solveTurnstileMin'
                ).then(res => ({ token: res, code: 200 }))
                 .catch(err => ({ code: 500, message: err.message }))
                break

            case 'turnstile-max':
                result = await withTimeout(
                    solveTurnstileMax(data),
                    taskTimeout,
                    'solveTurnstileMax'
                ).then(res => ({ token: res, code: 200 }))
                 .catch(err => ({ code: 500, message: err.message }))
                break

            case 'waf-session':
                result = await withTimeout(
                    wafSession(data),
                    taskTimeout,
                    'wafSession'
                ).then(res => ({ ...res, code: 200 }))
                 .catch(err => ({ code: 500, message: err.message }))
                break

            default:
                result = { code: 400, message: `Unknown mode: ${data.mode}` }
        }
    } catch (err) {
        console.error('[Request Error]', err.message)
        result = { code: 500, message: err.message }
    } finally {
        // ★ 关键：无论成功失败，计数器必须递减
        global.browserLength--
    }

    // 防止响应已发送后再次发送
    if (!res.headersSent) {
        res.status(result.code ?? 500).json(result)
    }
})

app.use((req, res) => {
    res.status(404).json({ code: 404, message: 'Not Found' })
})

// ============================================
// 7. 定期清理 - 检测僵尸页面和内存状况
// ============================================
setInterval(async () => {
    try {
        if (global.browser && global.browser.isConnected && global.browser.isConnected()) {
            const pages = await global.browser.pages()
            console.log(`[Health] Active pages: ${pages.length}, Queue: ${global.browserLength}/${global.browserLimit}`)

            // 关闭多余的空白页面（防止页面泄漏）
            for (const page of pages) {
                try {
                    const url = page.url()
                    if (url === 'about:blank' && pages.length > 1) {
                        await page.close()
                        console.log('[Cleanup] Closed blank page')
                    }
                } catch (_) {}
            }
        }

        // 如果计数器异常（负数或不合理的高值），重置
        if (global.browserLength < 0) {
            console.warn('[Fix] browserLength was negative, resetting to 0')
            global.browserLength = 0
        }

        // 内存监控
        const mem = process.memoryUsage()
        console.log(`[Memory] RSS: ${(mem.rss / 1024 / 1024).toFixed(1)}MB, Heap: ${(mem.heapUsed / 1024 / 1024).toFixed(1)}/${(mem.heapTotal / 1024 / 1024).toFixed(1)}MB`)

    } catch (e) {
        console.error('[Health Check Error]', e.message)
    }
}, 60000) // 每分钟检查一次

if (process.env.NODE_ENV === 'development') module.exports = app
