# 分类同步实现

- `src/categories.js`：分类目录、确认状态、普通文件遍历、路径及符号链接检查、二进制读取。
- `src/profile.js`：配置持久化、旧版白名单兼容、bundle、原字节备份与原子覆盖。
- `src/pipeline.js`：UI/Agent 共用的收集、扫描、推送及按类别过滤拉取流程。
- `src/tools.js`：五个 Agent 工具。串行执行避免 UI 与 Agent 在本进程交错修改；失败返回可读诊断与询问 Agent 提示。
- `src/settings.js`：通过宿主 webServer 注册 JSON POST API，校验 Origin / Sec-Fetch-Site，限制请求体大小。沿用宿主访问控制，不自建服务器。
- `client.js`：ModuleLoader 加载 React 半体；注册 settings.section 与 settings.plugins.tab；敏感项勾选确认、先预览后拉取。
- `src/github.js`：Git Data API；二进制使用 base64 blob；更新 ref 永不 force。

分类只决定文件集合，不拆分单个配置文件。UI 使用用途名称及数量，不展示原始文件路径供勾选。未知普通文件归入默认关闭的敏感“其他文件”。API Key 根据文件名优先分类；其他内容仍扫描常见密钥格式。

新配置仅开启 core。敏感类别需要 categories 与 confirmedSensitive 同时包含才可收集/拉取；confirmSensitive 只能在用户确认后由 UI/Agent 传入。includeSecrets 旧开关继续兼容，因此它开启时会允许所有选中内容中的扫描命中。确认记录只代表用户授权，不提供加密。Git 历史里的秘密需要另行清理及轮换。

取消勾选只影响未来操作，不删除已上传内容。镜像删除保留原有 skills 范围且必须在选中类别内。Profile 外、符号链接、Git 数据及自身同步数据被排除；单文件 50MB 上限。所有类别共享一个 Profile，其他 Profile 不遍历。

拉取先按本机选择过滤远端条目，再下载，避免读取未授权内容；路径与链接在写前检查，覆盖/删除前备份。单文件通过独占临时文件和 rename 写回；整组多文件不是事务，途中失败需从备份恢复。跨进程写入及恶意本地进程造成的 TOCTOU 竞态不在本进程串行保护内。

参照：https://github.com/ranxianglei/billion-context 的 src/agent/dsh-native-client.ts 与 src/agent/dsh-native.ts。

## 0.2.1 / DSH 0.2.0-rc.2 兼容修复

- bundle insert 名称、浏览器 ModuleLoader id 与插件配置 slot key 均与 npm 包名 `@dsd486/dsh-sync` 一致。
- 精确声明 `@deepseek-ai/dsh-tools: 0.2.0-rc.2`，避免宽范围解析到未验证 SDK；声明 DSH 引擎目标。
- 按 rc.2 的 schema DSL 为所有 object 明确 additionalProperties，允许实际返回的 null；所有工具提供 output.render，返回文本 ContentBlock 数组。
- `scripts/check-sdk.js` 用官方 SDK 编译器验证注册、样例回执及渲染，不执行同步。真实宿主启动与完整 GitHub 同步仍需在 DSH 实机验收。

## 0.2.2 / 插件入口加载修复

参照用户提供的 billion-context 与 dsh-codex-ui manifest：明确声明客户端对 ui-settings 的加载依赖。对照官方 rc.2 settings slot 类型，使用 settings.section 与 settings.plugins.tab；不再使用该版本未声明的 plugins.bundle.config。服务端不再把 tools 作为整包的必要服务；设置 API 通过 webServer 独立注入，Agent 工具通过 tools 独立注入，SDK 延迟导入。无 tools 环境的挂载与卸载回归测试通过。真实 Profile 中的已安装/已启用状态仍须在运行的 DSH 上核验。
