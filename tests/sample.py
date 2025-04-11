import requests
import threading
import time
from loguru import logger

# 使用锁来保证对集合的安全访问
lock = threading.Lock()
token_set = set()


def get_turnstiles():
    while True:
        url = 'https://testnet.megaeth.com/'
        site_key = '0x4AAAAAABA4JXCaw9E2Py-9'
        mode = 'turnstile-min'
        try:
            response = requests.post(
                'http://localhost:3000/cf-clearance-scraper', timeout=60,
                json={
                    'url': url,
                    'siteKey': site_key,
                    'mode': mode,
                }
            )
            response.raise_for_status()
            if response.status_code == 200:
                token_list = response.json()['token']
                for turnstile_token in token_list:
                    # with lock:  # 确保对集合的访问是线程安全的
                    token_set.add(turnstile_token)  # 将 token 添加到集合中

        except Exception as error:
            time.sleep(3)


def get_token_from_set():
    while True:
        with lock:  # 确保访问集合时是线程安全的
            if token_set:
                token = token_set.pop()  # 从集合中弹出一个 token
                logger.info(f"消费了 token: {token}")
                time.sleep(1)  # 模拟处理时间
                logger.success(f'池子剩余{len(token_set)}个token')

            else:
                logger.info("池子为空，等待生产数据...")
                time.sleep(1)  # 如果集合为空，等待一段时间


if __name__ == '__main__':
    threads = []
    for i in range(5):
        t = threading.Thread(target=get_turnstiles)
        threads.append(t)
        t.start()

    # 启动一个线程去消费队列
    consumer_thread = threading.Thread(target=get_token_from_set)
    consumer_thread.start()

    # 等待消费者线程完成
    consumer_thread.join()
