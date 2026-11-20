# 改动纪律（由于历史事故总结，强制）

## 为什么有这个文件

0.49.2x 期间连续出现 4 个「语法合法、构建通过、但运行时不工作」的 bug：

| # | Bug | 为什么静态检查抓不到 |
|---|---|---|
| ① | `saveCloudConn` 少一个闭合括号，把 `syncCloudConnToServer` 吞进内部 | 语法合法；调用时才抛 ReferenceError，被上层空 catch 吃掉 |
| ② | `POST /cloud/conn` 响应把 token 脱敏成 `***`，客户端存进 localStorage 再回写 | 每步都"成功" |
| ③ | 启动同步拿空值回写，抹掉服务端有效密钥 | 同上 |
| ④ | `readPkgVersion` edit 报成功但没落盘，`/overview` 直接 500 | 缺定义只有运行时才炸 |

共同点：**没有异常抛到用户能看见的地方，只有"点了没反应"**。

## 强制流程

改完代码后，**必须先本地验证再交付**：

```bash
node scripts/verify.mjs
```

它会做六件事：

1. **语法检查** 所有入口（index.js / api.js / cloud-server.js / cloud-push.js / client.js / app.js）
2. **构建产物完整性** 检查关键标识符是否真的进了 bundle（防 edit 没落盘）
3. **构建**
4. **关键函数作用域** 断言 saveCloudConn / applyCloudConn 等必须是模块级（防误嵌套）
5. **测试套件**
6. **运行时冒烟**：真起一个实例（端口 7907），打 6 个接口并断言：
   - 全 200
   - `/overview` 带 version + pkgVersion
   - 卡片数 `/cards` = `/vaults.current` = `/stats`
   - `/setup-status` 的 mcpPath 不许出现 `/root` `/opt` `/var`
   - `/cloud/conn` 的 token 不许是 `***`

**门禁不过不许交付。**

## 安装到本机（改完必做）

```powershell
# 1. 门禁
node scripts/verify.mjs

# 2. 打包
npm pack --pack-destination dist

# 3. 覆盖安装
$nm = "$env:USERPROFILE\.dsh\profiles\desktop\node_modules"
Remove-Item "$nm\memory-eternal" -Recurse -Force -EA SilentlyContinue
New-Item -ItemType Directory "$nm\memory-eternal" -Force | Out-Null
tar -xzf "dist\memory-eternal-<版本>.tgz" -C "$nm\memory-eternal" --strip-components=1

# 4. **杀掉常驻实例**（否则跑的还是旧代码，DSH 重启也不管它）
$c = Get-NetTCPConnection -LocalPort 7999 -State Listen -EA SilentlyContinue | Select-Object -First 1
if ($c) { Stop-Process -Id $c.OwningProcess -Force }
Start-Sleep -Seconds 6

# 5. 自检
node scripts/doctor.mjs
```

## 用户侧诊断

任何"不对劲"，先跑：

```bash
node scripts/doctor.mjs
```

五项：安装版本 / 运行实例（含磁盘 vs 运行版本比对）/ 数据一致性 / 云端授权 / MCP 路径。

**哪项红就是哪项的锅，不要猜。**

## 架构红线

1. **本机专属接口永不代理到云端**
   - 客户端：`LOCAL_ONLY` 白名单（/setup-status /mcp/action /vault-path /open-path /web-info /events /drain-pending）
   - 服务端：云端 400 `local_only` 兜底
   - 这些接口操作的是**用户这台电脑**的文件，与数据存在哪无关

2. **配置合并，不覆盖**
   `writeCloudConn` 拿不到新值就保留旧值；空 token 不能覆盖有效密钥；`***` 直接拒绝

3. **不脱敏本机回环的访问密钥**
   `GET/POST /cloud/conn` 都返回完整 token。127.0.0.1 上脱敏只会让客户端无法恢复状态

4. **启动即激活**
   `bootstrapCloudMode()` 在模块加载时执行；`syncConnFromServer()` 从服务端恢复。
   否则 `mode=cloud` 但 `API_TARGET_URL` 是空，所有请求打本机

5. **整个文件是单文件巨型组件（17000+ 行）**
   改任何被多处引用的值，先确认它**定义在哪一层作用域**。
   跨组件引用、函数误嵌套，是这里最容易犯的错
