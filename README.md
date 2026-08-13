# 文章自动下载（Literature Downloader Suite）

面向具有机构数据库订阅权限（CARSI / WebVPN / 图书馆统一认证）研究者的**合法学术全文下载工具套件**。
它把你已授权的浏览器会话接入批量工具，逐篇抓取论文全文 HTML 与 PDF，内置限速与熔断保护，
避免触发出版商反滥用系统。

> **本套件不产生访问权限。** 你必须拥有所在机构的合法订阅。它绝不绕过付费墙、验证码、DRM
> 或双因素认证。

## 组件

| 组件 | 来源 | 作用 |
|---|---|---|
| `skills/nature-downloader` | [Yuan1z0825/nature-skills](https://github.com/Yuan1z0825/nature-skills)（MIT） | DOI 路由：OA → 出版商 API → 机构浏览器 |
| `skills/web-access` | [eze-is/web-access](https://github.com/eze-is/web-access)（MIT） | Chrome CDP 桥接，复用登录态 |
| `scripts/cdp-harvest.mjs` | 本仓库 | 通过桥接批量抓取全文 HTML |
| `scripts/cdp-pdf-fetch.mjs` | 本仓库 | 单篇 PDF 抓取（文章页 → 点击 View PDF → 抓取字节流） |
| `setup-bridge.ps1` | 本仓库 | 一键完成 Chrome 调试 + CDP 代理启动 |

许可证细节见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

## 环境要求

- Node.js 22+（Codex Desktop 自带）
- Python 3 + `pip install -r skills/nature-downloader/requirements.txt`
- Chrome（或 Edge），并已登录机构数据库
- 正常的网络出口 IP（校园网 / 家用宽带）。数据中心 IP 会被出版商与 Cloudflare 标记，
  导致 PDF 端点被拦截

## 快速开始

1. 将两个技能放入你的智能体技能目录
   （Codex：`~/.codex/skills/`；Claude Code：`~/.claude/skills/`），或直接在本仓库内调用脚本。
2. 配置你的学校：

   ```powershell
   python skills/nature-downloader/scripts/configure_school.py url "https://你的图书馆入口"
   ```

3. 在 Chrome 中完成一次机构登录
   （如 ScienceDirect → Sign in → 通过机构访问 → 选择你的学校）。
4. 启动桥接：

   ```powershell
   .\setup-bridge.ps1
   ```

5. 批量抓取全文 HTML（最快，机房 IP 下也可用）：

   ```powershell
   node scripts/cdp-harvest.mjs --list list.csv --out .\downloads
   ```

   `list.csv` 格式：`record_id,authoritative_url`

6. 或抓取单篇 PDF：

   ```powershell
   node scripts/cdp-pdf-fetch.mjs --article "https://www.sciencedirect.com/science/article/pii/<PII>" --out .\downloads\MC-001.pdf
   ```

完整用法、排错与安全上限见 [USER_GUIDE.md](USER_GUIDE.md)。

## 内置安全控制（默认开启）

- 严格串行处理（无并发）
- 每篇之间随机等待 8–15 秒
- 重跑自动跳过已下载项
- 熔断保护：连续 3 篇被拦截自动停止
- PDF 重试上限 2 次；检测到反爬页立即放弃
- 每篇 PDF 成功后冷却 15 秒

请遵守图书馆规则：保持正常阅读量（每出版商每天 ≤30–50 篇 PDF），切勿共享机构账号。

## Chrome 151 说明

新版 Chrome 会忽略默认配置目录下的 `--remote-debugging-port`，且不再自动写入
`DevToolsActivePort`。本仓库的 web-access 副本包含补丁（`WEB_ACCESS_CHROME_DATA_DIR`
环境变量），`setup-bridge.ps1` 会自动处理端口文件。

## 许可

本仓库自有的脚本与文档：MIT。第三方组件保留上游许可证——见
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

English version: [README_EN.md](README_EN.md)
