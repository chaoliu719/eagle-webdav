#!/bin/bash
# 对比我们的服务（41600）和 rclone 的服务（41601）的原始响应。
# 先在终端运行：rclone serve webdav /tmp --addr 127.0.0.1:41601
BODY1='<?xml version="1.0" encoding="utf-8"?><D:propfind xmlns:D="DAV:"><D:prop><D:getlastmodified/><D:getcontentlength/><D:creationdate/><D:resourcetype/></D:prop></D:propfind>'
BODY2='<?xml version="1.0" encoding="utf-8"?><D:propfind xmlns:D="DAV:"><D:prop><D:quota-available-bytes/><D:quota-used-bytes/><D:quota/><D:quotaused/></D:prop></D:propfind>'
for port in 41600 41601; do
  echo "================ PORT $port ================"
  echo "--- OPTIONS"; curl -si -X OPTIONS "http://127.0.0.1:$port/"
  echo; echo "--- PROPFIND 1"; curl -si -X PROPFIND -H "Depth: 0" -H "Content-Type: text/xml" -d "$BODY1" "http://127.0.0.1:$port/"
  echo; echo "--- PROPFIND 2"; curl -si -X PROPFIND -H "Depth: 0" -H "Content-Type: text/xml" -d "$BODY2" "http://127.0.0.1:$port/"
  echo
done
