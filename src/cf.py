import socket
import subprocess
import time

script_path = r"D:\cf-clearance-scraper-main\src"


def is_port_in_use(port=3000, host="127.0.0.1"):
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        return s.connect_ex((host, port)) == 0


def run_js():
    port = 3000
    if is_port_in_use(port):
        print(f"端口 {port} 已被占用")
    else:
        print(f"端口 {port} 可用，启动 Node.js 服务...")

        # 切换到目标目录并运行 npm start
        subprocess.run("npm start", shell=True, cwd=script_path)


def main():
    while True:
        run_js()
        time.sleep(3)


if __name__ == "__main__":
    main()
