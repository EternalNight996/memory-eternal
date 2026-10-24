# memory-eternal · 私有化部署镜像（单租户：一个容器 = 一个记忆库）
#
# 运行时不依赖第三方 npm 包（独立 web / MCP / CLI 都只用本仓库代码），
# 因此镜像不做 npm install，构建快、攻击面小。数据持久化到 /data。
FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production \
    MEMORY_WEB_PORT=7999

COPY package.json ./
COPY index.js cordis.patch.yml ./
COPY bin ./bin
COPY lib ./lib
COPY web ./web
COPY hooks ./hooks
COPY skills ./skills
COPY assets/icon.png ./assets/icon.png

# 记忆库（SQLite + WAL）与备份都在这个卷里
VOLUME ["/data"]
EXPOSE 7999

HEALTHCHECK --interval=30s --timeout=4s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:7999/memory-eternal/api/overview').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# 只在这个容器内监听 0.0.0.0；对外请用反向代理 + 认证，或 compose 里绑定 127.0.0.1
CMD ["node", "bin/dsh-memory.mjs", "serve", "--port", "7999", "--host", "0.0.0.0", "--vault", "/data"]
