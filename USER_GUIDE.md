# 文献自动下载套件 · 用户指南

## 适用人群

有高校或机构数据库订阅权限（CARSI / WebVPN / 图书馆统一认证）的研究人员。
本套件**不产生访问权限**，只负责把你已有的合法机构权限接到自动化流程上。

## 能做什么

- 通过你已登录的浏览器会话，逐篇抓取论文**全文 HTML**（含完整正文）
- 通过模拟用户点击"View PDF"，抓取 **PDF**
- 支持 Elsevier / ScienceDirect、Wiley、Springer、IEEE、Emerald 等主流出版商
  （能否下载取决于你机构订阅的数据库）

## 前置条件

| 项目 | 要求 |
|---|---|
| Node.js | 22+（Codex Desktop 自带，或单独安装） |
| Python | 3.x（配置与 PDF 校验用） |
| 浏览器 | Chrome（需能登录机构数据库） |
| 网络 | 校园网 / 家用宽带等正常 IP；机房 IP 会被反爬拦截 |
| 权限 | 你所在机构的数据库订阅 + 统一认证账号 |

## 方式一：作为 AI 技能使用（推荐）

1. 把 `skills\nature-downloader` 和 `skills\web-access` 复制到你的技能目录：
   - Codex：`%USERPROFILE%\.codex\skills\`
   - Claude Code：`%USERPROFILE%\.claude\skills\`
2. 安装 Python 依赖：

   ```powershell
   python -m pip install -r skills\nature-downloader\requirements.txt
   ```

3. 配置你的学校：

   ```powershell
   python skills\nature-downloader\scripts\configure_school.py url "https://你的学校图书馆入口"
   ```

4. 在 Chrome 里完成一次机构登录（ScienceDirect → Sign in → 通过机构访问 → 选择你的学校）。
5. 对 AI 说："用文献下载技能批量下载这些 DOI 的正文"。

## 方式二：命令行直接使用

### 1. 启动桥接

```powershell
.\setup-bridge.ps1
```

脚本会自动：启动调试 Chrome（独立配置目录）→ 写入 DevToolsActivePort → 启动 CDP 代理。
启动后请在自动化 Chrome 窗口里重新确认机构登录状态。

### 2. 抓取全文 HTML（推荐先用这个）

准备一个清单文件 `list.csv`（两列：`record_id,authoritative_url`），然后：

```powershell
node scripts\cdp-harvest.mjs --list list.csv --out .\downloads
```

输出：`downloads\FullText\MC-001.html`（完整正文 HTML）+
`downloads\FullTextText\MC-001.txt`（纯文本提取）。

### 3. 抓取单篇 PDF

```powershell
node scripts\cdp-pdf-fetch.mjs --article "https://www.sciencedirect.com/science/article/pii/<PII>" --out .\downloads\MC-001.pdf
```

脚本会打开文章页 → 模拟点击 "View PDF" → 从 PDF 标签页抓取字节流。

### 4. 官方批量脚本（可选）

```powershell
node skills\nature-downloader\scripts\batch_download.mjs --dois "<doi1>,<doi2>" --route web_access --no-si --out .\downloads
```

## 常见问题

- **PDF 弹 "There was a problem providing the content"（CPE00001）**：出口 IP 被 Elsevier
  标记（常见于机房/云服务器 IP）。换校园网或家用宽带即可；全文 HTML 不受此限制。
- **页面一直显示"请稍候…"**：Cloudflare 人机验证，等 30 秒左右通常自动通过；若持续不通过，
  说明该 IP 被标记，换网络重试。
- **某篇显示只有摘要**：你机构没有订阅该刊（如部分 APS、部分 Wiley 期刊），需走图书馆文献传递。
- **提示 credentials_missing**：该 DOI 属于 Elsevier/Springer/IEEE，且未配置 API Key。
  直接加 `--route web_access` 走机构浏览器即可，或到开发商门户注册免费 API Key。
- **下载很慢**：套件刻意限速（逐篇、间隔数秒），避免触发数据库封禁。

## 合规提示

- 只下载你机构已订阅、且你本人有权阅读的论文。
- 不要并发批量狂拉，不要分享机构账号——数据库商会对异常下载封 IP、封账号，甚至牵连全校。
- 本套件不绕过付费墙，只使用你的合法机构访问。

## 内置下载控制（已默认开启）

- **串行执行**：始终逐篇处理，绝无并发。
- **随机间隔**：每篇之间随机等待 8–15 秒（可调 `--min-delay` / `--max-delay`）。
- **跳过已完成**：已存在的 HTML/PDF 自动跳过，重跑不会重复下载（`--no-skip-existing` 可关闭）。
- **熔断保护**：连续 3 篇被拦截（Cloudflare/CPE00001）自动停止，避免对同一 IP 反复试探。
- **PDF 重试上限**：单篇最多重试 2 次，且检测到反爬页立即放弃，不硬碰。
- **间隔冷却**：PDF 抓取成功后默认冷却 15 秒（`--cooldown` 可调）。

## 建议的个人使用上限（人工遵守）

- 单日每个出版商 ≤ 30–50 篇 PDF（正常阅读节奏远达不到这个量）。
- 单篇被拦截后，冷却 10–30 分钟再试；连续两次被拦当天放弃该篇。
- 优先在校园网/家用宽带运行；机房 IP 无论多慢都会被标记。
