# DSH 同步插件

把 DSH 的设置、技能等内容备份到你自己的 GitHub 仓库，换电脑后再恢复。

**下面按 Windows 操作。先装好 DSH，再从第 1 步开始。**

## 1. 安装插件

本版适配 **DSH 0.2.0-rc.2**。

```powershell
dsh plugin --profile web add @dsd486/dsh-sync@0.2.2
```

**如果提示找不到 `dsh` 命令：**

打开 DSH 的插件管理器 → 选择“本地目录”安装 → 选中 `C:\dsh-sync-plugin` → 安装后重启 DSH。

### 安装后列表里没有？

确认安装到了正在运行的同一个 Profile：上面命令安装到 `web`。如果你使用的是 `desktop`，改用：

```powershell
dsh plugin --profile desktop add @dsd486/dsh-sync@0.2.2
```

安装后完全退出 DSH 再打开，检查“设置 → DSH 同步”或“设置 → 插件 → DSH 同步”。不要只执行 `npm install`，要使用 `dsh plugin … add` 启用插件。

## 2. 创建一个存备份的 GitHub 仓库

1. 登录 GitHub，打开 [新建仓库页面](https://github.com/new)。
2. 仓库名称填写：`dsh-backup`。
3. 选择 **Private（私有）**。
4. 点击 **Create repository**。

记下仓库地址。例如：

```text
https://github.com/你的用户名/dsh-backup
```

**这是存你个人备份的仓库，不是插件源码仓库。**

## 3. 创建 GitHub 令牌

令牌相当于允许插件访问备份仓库的密码。

1. 打开 [创建令牌页面](https://github.com/settings/personal-access-tokens/new)。
2. **Token name** 填：`dsh-sync`。
3. **Expiration** 选择有效期；过期后需要换新令牌。
4. **Resource owner** 选择你的账号。
5. **Repository access** 选择 **Only select repositories**。
6. 只勾选刚建的 **dsh-backup**。
7. 在 **Repository permissions** 中，把 **Contents** 设为 **Read and write**。
8. 点击 **Generate token**，复制生成的令牌。

**令牌只显示一次。不要发给 AI，也不要放到 GitHub 文件里。**

## 4. 把令牌存到这台电脑

打开 **PowerShell**，复制下面两行一起执行：

```powershell
$token = Read-Host "粘贴 GitHub 令牌，然后按回车（输入不会显示）" -AsSecureString
[Environment]::SetEnvironmentVariable("DSH_SYNC_TOKEN", ([System.Net.NetworkCredential]::new("", $token)).Password, "User")
```

出现提示后，粘贴第 3 步的令牌，按回车。

**完全退出 DSH，再重新打开。** 如果仍提示没有令牌，注销 Windows 后重新登录，再打开 DSH。

## 5. 填写同步设置

打开 DSH → **设置 → DSH 同步**。也可以在插件详情页找同步设置。

| 界面上的项目 | 填什么 |
|---|---|
| GitHub 仓库 | `你的用户名/dsh-backup`，不要带 `https://github.com/` |
| 分支 | `main` |
| 仓库内保存位置 | `dsh-sync` |
| GitHub 令牌引用 | `env:DSH_SYNC_TOKEN`，直接复制这一项，不要填令牌本身 |

例如，你的 GitHub 用户名是 `xiaoming`，“GitHub 仓库”就填：

```text
xiaoming/dsh-backup
```

## 6. 勾选要备份的内容

**第一次建议只选前两项：**

- ☑ 模型、插件与界面设置
- ☑ 技能

其他内容按需选择：

| 类别 | 什么时候勾选 |
|---|---|
| 安装策略与依赖清单 | 想保留安装规则时 |
| API Key / 登录凭证 | 想连 API Key 一起备份时 |
| 聊天记录 | 想备份聊天内容时 |
| 插件数据 | 想备份插件保存的数据时 |
| 插件程序与缓存 | 确实需要时，内容可能很大 |
| 其他文件 | 想备份其他本地内容时 |

**敏感项默认不勾选。** 勾选时会弹出警告，确认后才会启用。

> API Key 等内容上传后会留在 GitHub 历史中。之后取消勾选，不会删除已经上传的内容。

## 7. 第一次备份

依次点击：

1. **保存设置**
2. **检查状态**
3. **推送到 GitHub**

看到“已推送”后，打开你的 `dsh-backup` 仓库，检查有没有出现 `dsh-sync` 文件夹。

**以后备份：打开这个页面，点“推送到 GitHub”。插件不会定时自动备份。**

## 8. 换电脑后恢复

1. 在新电脑安装 DSH 和本插件。
2. 按第 4 步保存 GitHub 令牌。
3. 按第 5 步填写**同一个备份仓库**。
4. 勾选想恢复的类别，点击 **保存设置**。
5. 点击 **预览拉取**，查看将覆盖、新增的文件。
6. 确认后，点击 **确认拉取**。
7. 完全退出 DSH，再重新打开。

注意两件事：

- 没有备份 API Key 的话，需要在新电脑重新填写。
- 恢复插件清单后，可能还需要去插件管理器重新安装其他插件。

## 同步失败怎么办？

在 DSH 聊天框里，把下面这句话发给 Agent：

```text
DSH 同步失败了，请用 sync_config 查看配置，用 sync_status 检查原因。
不要显示我的密钥，也不要直接覆盖本地文件。先告诉我哪里出错、怎么修复。
```

也可以补上界面显示的错误提示，**不要附上令牌或 API Key**。

| 错误提示 | 先检查什么 |
|---|---|
| 没有可用令牌 | 做完第 4 步后有没有完全重启 DSH |
| 401 | 令牌是否过期，重新做第 3、4 步 |
| 403 | 令牌是否选对仓库，Contents 是否为 Read and write |
| 404 | 仓库名称是否正确；空仓库要先推送一次 |
| 明文密钥扫描命中 | 让 Agent 检查，不要随便关闭保护 |
| 文件超过 50MB | 取消对应类别，或让 Agent 帮你找出大文件 |

## 只需知道的限制

- 只同步当前这套 DSH 配置，不会备份整台电脑。
- 不勾选的类别不会被拉取或覆盖；取消勾选也不会清理远端历史。
- 插件自己的 GitHub 令牌、备份文件和文件快捷链接不会上传。
- 拉取覆盖前会保存旧文件；恢复出错时，可以让 Agent 帮你找备份。
<details>
<summary>维护者发布新版（普通用户不用看）</summary>

本次修复版本为 `0.2.2`。在仓库目录执行：

```powershell
npm test
npm pack --dry-run
npm publish --access public
```

已安装 DSH SDK 的开发环境还可执行 `npm run test:sdk`，检查工具注册、输出规范及包名一致性；该检查不会执行同步。

</details>
