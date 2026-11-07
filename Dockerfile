# memory-eternal MCP server (stdio)
# 用法：
#   docker build -t memory-eternal-mcp .
#   docker run -i --rm -v memory-vault:/root/.dsh/memory-vault memory-eternal-mcp
FROM node:22-alpine
LABEL org.opencontainers.image.title="memory-eternal" \
      org.opencontainers.image.description="Local-first long-term memory MCP server" \
      org.opencontainers.image.source="https://github.com/EternalNight996/memory-eternal"
RUN npm install -g memory-eternal@0.27.1
ENV DSH_HOME=/root/.dsh
VOLUME ["/root/.dsh/memory-vault"]
ENTRYPOINT ["dsh-memory", "mcp"]
