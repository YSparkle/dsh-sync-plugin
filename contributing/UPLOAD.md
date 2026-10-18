# 上传仓库 & 提交收录（awesome-dsh-plugin）操作指南

目标：把 `dsh-sync-plugin/` 推上 `https://github.com/YSparkle/dsh-sync-plugin`（**源码仓库，投稿用**），然后给插件列表仓库提交一个收录 PR。全程网页 + 命令行混合，每步都能照抄。

> 分工说明：`YSparkle/DSH-sync` 是插件的**配置同步**仓库（`dsh-sync/` 目录，由插件自动读写），与投稿无关，不用动它。

## 0. 前提

- GitHub 账号；`dsh-sync-plugin/` 在本机就绪（`node scripts/selfcheck.js` 全绿）。
- 推送需要认证：网页方式用浏览器登录即可；命令行方式第一次 push 会弹出 **Git Credential Manager** 登录窗口，或用你的 fine-grained PAT 当密码（用户名 `YSparkle`，密码粘贴 PAT）。
- 网络超时就给 git 挂代理：`git config --global http.proxy http://127.0.0.1:7890`（不用了再 `--unset`）。

## 1. 上传插件仓库（二选一）

### 方式 A：命令行（推荐；本目录已 git 就绪：单提交历史、origin 已指向新仓库）

1. 在 github.com 新建仓库 `dsh-sync-plugin`（名字必须精确；**不要**勾选任何初始化选项——不要 README、不要 .gitignore、不要 license）。
2. 回到终端跑一条命令：

```sh
cd dsh-sync-plugin
git push -u origin main
```

> 若报 `Repository not found`，先做第 1 步；若提示认证，Git Credential Manager 登录一次即可。

### 方式 B：纯网页（不想碰命令行）

1. github.com 新建仓库 `dsh-sync-plugin`（同样不要初始化）。
2. 仓库页 **Add file → Upload files** → 把 `dsh-sync-plugin/` 里的文件全部拖进去（`node_modules`、`scripts\out`、`.git` 除外）→ Commit。

配套阅读：收录规则原文已存在本仓库 [`contributing/awesome-contributing.md`](contributing/awesome-contributing.md)（awesome-dsh-plugin 的 contributing.md 副本）；本文件第 4 节速查表均摘自它。

## 2. 仓库设置（两条硬性规则）

1. **打 topic**：仓库页右侧 About → 齿轮 → Topics 填 `dsh-plugin` 保存（列表要求所有收录仓库带这个 topic）。
2. **满 1 天再提 PR**：列表 CI 会自动检查仓库创建时间，刚建的仓提交会被拒——第二天再提即可，重新提交没有任何影响。

## 3. 提交收录 PR（一个文件就是全部投稿）

1. 打开列表仓库（awesome-dsh-plugin），右上角 **Fork**。
2. Fork 里 **Add file → Create new file**，文件名（⚠️ 必须按这个格式，它就是你的条目）：

   ```
   data/plugins/YSparkle__dsh-sync-plugin.yml
   ```

3. 粘贴本目录 `submission-entry.yml` 的内容（# 注释行可删），Commit。
4. 页面会自动出现 **Contribute → Open pull request**，标题写 `Add YSparkle/dsh-sync-plugin`，确认 base 是列表仓库的 `main`，提交。
5. 等 CI：绿了 maintenance 会人工读仓库核对**描述与代码是否一致**——描述里每个字都会被当真，这也是唯一容易被打回的点。分类选得不准没关系，维护者会直接改。

## 4. 硬性规则速查（contributing.md）

| 规则 | 我们的状态 |
|---|---|
| package.json 声明 `dsh.bundle`（只写 `dsh.client` 会被 CI 拒） | ✅ `dsh.bundle.patch` |
| 仓库 ≥1 天 | ⏳ 建仓次日提 PR |
| topic `dsh-plugin` | ⏳ 上传后记得打 |
| 一个 PR ≤3 条（我们只加 1 条） | ✅ |
| 描述属实、无营销词 | ✅ 与四个工具一一对应 |
| 真实可用代码 | ✅ 74 项自检 |
| 上游规则副本为最新 | ⏳ 提 PR 前对照上游 contributing.md 原版，手动替换本仓库 [`awesome-contributing.md`](awesome-contributing.md)（该文件声明勿手工编辑） |
| 两个 README 由脚本生成，**勿手改** | 只改自己的 yml |

## 5. 可选项（不加也完全不影响收录）

- **npm 发布**：让市场显示下载量。`package.json` 把 `private` 改 `false`、`repository` 指回本仓库（已就位）、`@sparkle` scope 需要 npm org（或改成无 scope 包名）→ `npm publish`。映射从 registry 自动采集，yml 里**不要**手写 `npm:` 字段。
- **预构建 tarball**：不发 npm 就在 GitHub Release 挂 `.tgz`，yml 加 `tarball:` 字段；资产名不要带版本号（或钉住 tag 写法）。
- **截图**：仓库根放 `screenshots.json`（1–8 张，相对路径），市场详情页会展示；不放则自动从 README 抽图。

## 6. 之后更新

改分类、改描述 → 编辑**自己的** `data/plugins/YSparkle__dsh-sync-plugin.yml` 再开 PR；不要手工编辑 README（会撞别人的行）。
