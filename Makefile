.PHONY: build run clean setup

# Build the speaker-demo binary
build:
	go build -o speaker-demo .

# Build and run (auto-opens browser)
run: build
	./speaker-demo

# Build and run without auto-opening browser
run-silent: build
	./speaker-demo --no-browser

# First-time setup: copy config from example
setup:
	@if [ ! -f config.json ]; then \
		cp config.json.example config.json; \
		echo "✅ config.json 已创建，请编辑填入你的腾讯云密钥"; \
		echo "   获取地址: https://console.cloud.tencent.com/cam/capi"; \
	else \
		echo "config.json 已存在，跳过"; \
	fi

# Clean build artifacts
clean:
	rm -f speaker-demo
