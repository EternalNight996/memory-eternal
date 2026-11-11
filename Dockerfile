# memory-eternal MCP server (stdio)
# 用法：
#   docker build -t memory-eternal-mcp --build-arg MEMORY_ETERNAL_VERSION=0.31.2 .
#   docker run -i --rm -v memory-vault:/root/.dsh/memory-vault memory-eternal-mcp
FROM node:22-alpine
LABEL org.opencontainers.image.title="memory-eternal" \
      org.opencontainers.image.description="Local-first long-term memory MCP server" \
      org.opencontainers.image.source="https://github.com/EternalNight996/memory-eternal"
ARG MEMORY_ETERNAL_VERSION=0.28.1
RUN npm install -g memory-eternal@${MEMORY_ETERNAL_VERSION}
ENV DSH_HOME=/root/.dsh
VOLUME ["/root/.dsh/memory-vault"]
ENTRYPOINT ["dsh-memory", "mcp"]
