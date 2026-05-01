"""Generate a 60-minute repo-intro deck (Traditional Chinese).

Run:
    python scripts/make_pptx.py

Writes ``repo-intro.pptx`` at the repo root. ~34 slides, 16:9.
"""
from __future__ import annotations

from pathlib import Path

from pptx import Presentation
from pptx.dml.color import RGBColor
from pptx.enum.shapes import MSO_SHAPE
from pptx.enum.text import PP_ALIGN
from pptx.util import Emu, Inches, Pt

# 16:9 in EMU.
SLIDE_W = Inches(13.333)
SLIDE_H = Inches(7.5)

# Palette — muted, projector-friendly.
ACCENT = RGBColor(0x1F, 0x4E, 0x79)        # deep blue
ACCENT_2 = RGBColor(0x2E, 0x75, 0xB6)      # mid blue
INK = RGBColor(0x1A, 0x1A, 0x1A)
MUTED = RGBColor(0x59, 0x59, 0x59)
BG_DIVIDER = RGBColor(0x1F, 0x4E, 0x79)
WHITE = RGBColor(0xFF, 0xFF, 0xFF)

CJK_FONT = "Microsoft JhengHei"
MONO_FONT = "Consolas"


def _add_textbox(
    slide,
    *,
    left: Emu,
    top: Emu,
    width: Emu,
    height: Emu,
    text: str,
    size: int,
    bold: bool = False,
    color: RGBColor = INK,
    font: str = CJK_FONT,
    align=PP_ALIGN.LEFT,
):
    box = slide.shapes.add_textbox(left, top, width, height)
    tf = box.text_frame
    tf.word_wrap = True
    p = tf.paragraphs[0]
    p.alignment = align
    run = p.add_run()
    run.text = text
    run.font.name = font
    run.font.size = Pt(size)
    run.font.bold = bold
    run.font.color.rgb = color
    return box


def _add_bullets(
    slide,
    *,
    left: Emu,
    top: Emu,
    width: Emu,
    height: Emu,
    items: list[str],
    size: int = 18,
    color: RGBColor = INK,
    line_spacing: float = 1.25,
):
    box = slide.shapes.add_textbox(left, top, width, height)
    tf = box.text_frame
    tf.word_wrap = True
    for i, item in enumerate(items):
        p = tf.paragraphs[0] if i == 0 else tf.add_paragraph()
        p.alignment = PP_ALIGN.LEFT
        p.line_spacing = line_spacing
        run = p.add_run()
        run.text = f"• {item}"
        run.font.name = CJK_FONT
        run.font.size = Pt(size)
        run.font.color.rgb = color
    return box


def _add_accent_bar(slide, *, top: Emu, height: Emu = Inches(0.08)):
    bar = slide.shapes.add_shape(
        MSO_SHAPE.RECTANGLE, Inches(0.7), top, Inches(1.5), height,
    )
    bar.fill.solid()
    bar.fill.fore_color.rgb = ACCENT_2
    bar.line.fill.background()


def _content_slide(prs: Presentation, title: str, bullets: list[str]):
    slide = prs.slides.add_slide(prs.slide_layouts[6])  # blank
    _add_textbox(
        slide,
        left=Inches(0.7), top=Inches(0.5),
        width=Inches(12), height=Inches(0.9),
        text=title, size=30, bold=True, color=ACCENT,
    )
    _add_accent_bar(slide, top=Inches(1.35))
    _add_bullets(
        slide,
        left=Inches(0.8), top=Inches(1.7),
        width=Inches(11.8), height=Inches(5.4),
        items=bullets, size=18,
    )
    return slide


def _section_divider(prs: Presentation, number: str, title: str, sub: str):
    slide = prs.slides.add_slide(prs.slide_layouts[6])
    bg = slide.shapes.add_shape(
        MSO_SHAPE.RECTANGLE, 0, 0, SLIDE_W, SLIDE_H,
    )
    bg.fill.solid()
    bg.fill.fore_color.rgb = BG_DIVIDER
    bg.line.fill.background()

    _add_textbox(
        slide,
        left=Inches(0.8), top=Inches(2.0),
        width=Inches(11), height=Inches(1.0),
        text=number, size=72, bold=True, color=WHITE,
    )
    _add_textbox(
        slide,
        left=Inches(0.8), top=Inches(3.2),
        width=Inches(11), height=Inches(1.2),
        text=title, size=44, bold=True, color=WHITE,
    )
    _add_textbox(
        slide,
        left=Inches(0.8), top=Inches(4.7),
        width=Inches(11), height=Inches(0.8),
        text=sub, size=20, color=RGBColor(0xCC, 0xDD, 0xEE),
    )
    return slide


def _title_slide(prs: Presentation):
    slide = prs.slides.add_slide(prs.slide_layouts[6])
    band = slide.shapes.add_shape(
        MSO_SHAPE.RECTANGLE, 0, 0, SLIDE_W, Inches(2.4),
    )
    band.fill.solid()
    band.fill.fore_color.rgb = ACCENT
    band.line.fill.background()

    _add_textbox(
        slide,
        left=Inches(0.7), top=Inches(0.7),
        width=Inches(12), height=Inches(1.0),
        text="claudeStruct", size=54, bold=True, color=WHITE,
        font="Segoe UI",
    )
    _add_textbox(
        slide,
        left=Inches(0.7), top=Inches(1.6),
        width=Inches(12), height=Inches(0.6),
        text="Claude Code 工作流的三件式工具組",
        size=22, color=RGBColor(0xDD, 0xEE, 0xFF),
    )
    _add_textbox(
        slide,
        left=Inches(0.7), top=Inches(3.2),
        width=Inches(12), height=Inches(0.6),
        text="60 分鐘 repo 導覽",
        size=28, bold=True, color=ACCENT,
    )
    _add_bullets(
        slide,
        left=Inches(0.8), top=Inches(4.0),
        width=Inches(11.5), height=Inches(2.5),
        items=[
            "claudestruct (Python) — 一次性、結構化的 Claude 呼叫",
            "claw-squad (TypeScript) — Planner / Coder / Reviewer 多 agent 編排",
            "claw-sandbox (Go) — 子程序的 rlimits + 路徑驗證 + 環境清洗",
        ],
        size=18,
    )
    _add_textbox(
        slide,
        left=Inches(0.7), top=Inches(6.7),
        width=Inches(12), height=Inches(0.5),
        text="講者：你 · 2026 · 內部技術分享",
        size=14, color=MUTED,
    )
    return slide


# --- Slide content ---------------------------------------------------

# Each entry: (title, [bullet, ...]).
# Section dividers are emitted by index — see SECTION_BREAKS.
SLIDES: list[tuple[str, list[str]]] = [
    # 1. cover handled separately

    # Section 1: 開場
    (
        "為什麼有這個 repo？",
        [
            "Claude Code 的工作流仍是手動調用：複製貼上、上下文管理、權限",
            "Anthropic prompt cache（1h TTL）+ ephemeral 控制需要正確使用才便宜",
            "想跑「Planner → Coder → Reviewer」的 multi-agent 還缺骨架",
            "想接 GitHub App、做 SaaS 商業化，需要租戶 / 權限 / 計費基底",
            "本 repo = 把這四件事一次處理掉的工程實作",
        ],
    ),
    (
        "60 分鐘的旅程",
        [
            "三件式工具總覽（8 分鐘）",
            "claudestruct 深入（10 分鐘）",
            "claw-squad 深入（10 分鐘）",
            "雲端化路徑 — Wave 4-8（12 分鐘）",
            "工程實踐：測試 / 觀測性 / 安全（8 分鐘）",
            "路線圖回顧（5 分鐘）+ Demo / Q&A（2 分鐘）",
        ],
    ),

    # Section 2: 三件式工具總覽
    (
        "三件式架構",
        [
            "claudestruct：薄、一次性，最適合 PR review、debug、一次性 plan",
            "claw-squad：厚、長時間執行，多個 agent 互相驗證",
            "claw-sandbox：縱深防禦，限制子程序的資源 / 路徑 / 環境",
            "三者各自獨立可用；組合時 claw-squad 透過 claw-sandbox 隔離 shell",
            "共用 prompt cache 哲學：system prompt 完全靜態、user turn 全動態",
        ],
    ),
    (
        "claudestruct (Python CLI)",
        [
            "進入點 src/claudestruct/cli.py，子命令 dev / review / plan / debug",
            "system prompt 用 cache_control: ephemeral（1h TTL）標記",
            "結構化日誌 --log-json，Prometheus metrics、cs dashboard 視覺化",
            "cs mcp 把它接到 Claude Code（透過 .mcp.json）",
            "適合：PR diff 評論、單檔修改建議、ad-hoc debug 假設排序",
        ],
    ),
    (
        "claw-squad (TypeScript)",
        [
            "進入點 claw-squad/src/cli.ts，狀態機跑 Planner→Coder→Reviewer",
            "8 個 model providers：Anthropic / OpenAI / Bedrock / Vertex / 本地…",
            "Skills 系統：apply_to glob 控制每個 agent 看到哪些技能",
            "Memory v2：lessons.md 跨 run 累積經驗",
            "CLI / TUI / Slack / Web UI 多介面，state.json 支援 --resume",
        ],
    ),
    (
        "claw-sandbox (Go)",
        [
            "single static binary，包裝任意子程序",
            "rlimits（CPU、memory、open files）阻止失控腳本",
            "路徑白名單 + 環境變數黑名單（清掉 SSH_AUTH_SOCK 等）",
            "啟動時 emit isolation JSON：每個控制是 ok / unsupported",
            "macOS 大多 unsupported；強隔離靠 Docker / firejail 包一層",
        ],
    ),
    (
        "三者如何協作",
        [
            "claw-squad 在 Coder phase 透過 claw-sandbox 跑 npm/pytest",
            "claudestruct 可在 PR webhook 中被 GitHub App 呼叫做 review",
            "兩者結構化日誌 schema 共享：run.start / agent.usage / cache.* / run.end",
            "同一個聚合器（cs dashboard 或 Prometheus）能吃兩者的事件",
            "Hosted SaaS 路徑：把 claw-squad 包成 worker，claudestruct 包成 API",
        ],
    ),

    # Section 3: claudestruct 深入
    (
        "四種任務 dev / review / plan / debug",
        [
            "dev：給定描述 + 檔案，回最小修改 patch + 風險評估",
            "review：對當前 branch diff 做結構化 PR 評論（嚴重度分級）",
            "plan：先問澄清題、再產出實作步驟，不直接寫 code",
            "debug：列假設並排序，每個附驗證指令；不跳到「修好了」",
            "四個 task 各自有獨立 system prompt + 對應的測試 fixture",
        ],
    ),
    (
        "Prompt caching 是核心",
        [
            "Anthropic 1h TTL，cache_control: ephemeral 標在 system prompt",
            "system prompt 必須 byte-for-byte 穩定 — 任何變動都讓整段失效",
            "時間戳 / UUID / 動態檔案內容 → 一律放在 user turn",
            "cache hit 收費約 1/10，重要任務一天跑數十次才划算",
            "我們會印 cache hit-rate；連續 miss 會觸發警示（W6.5）",
        ],
    ),
    (
        "Cache hit-rate 警示機制",
        [
            "cache_state.json 記錄最近 N 次 run 的 hit-rate 滑動視窗",
            "低於門檻會 emit cache.warning / cache.phase 結構化事件",
            "幫助 catch system prompt 不小心引入動態值的 regression",
            "整合到 cs dashboard：視覺呈現「健康 / 警示 / 嚴重」",
            "PR #38 完成 Wave 6.5 alerts；多租戶版本將擴成 per-org",
        ],
    ),
    (
        "結構化日誌 + cs dashboard",
        [
            "--log-json <path> 寫 JSONL：run.start / agent.usage / run.end",
            "schema 與 claw-squad 共用，方便聚合分析",
            "cs dashboard 讀同一份 log，繪出 token / 時間 / cache 走勢",
            "支援 cs dashboard diff <runA> <runB>：兩次 run 的差異報告",
            "Day-2 ops：cs runs purge --older-than-days N 清舊 log",
        ],
    ),
    (
        "cs metrics + Prometheus 整合",
        [
            "cs metrics 從 JSONL 算 sum / p50 / p95 並輸出 Prometheus 格式",
            "可掛到 Grafana — 預先打包好 dashboard JSON",
            "監控指標：token 用量、cache hit-rate、latency、錯誤率",
            "支援 cost-regression alerts：今日對比近 7 日成本暴增",
            "Wave 8 SLO 規格：/v1/slo + 成本回歸偵測會走同一條管道",
        ],
    ),
    (
        "cs mcp — 把 claudestruct 接到 Claude Code",
        [
            "cs mcp 走 stdio，符合 Model Context Protocol",
            "暴露 6 個工具：dev / review / plan / debug / dashboard / metrics",
            "MCP SDK lazy-import，預設安裝不付這份依賴",
            "在 Claude Code .mcp.json 設定一次，往後直接 /tools 呼叫",
            "claw-squad 也有對應的 claw-squad mcp（read-only：dashboard / runs）",
        ],
    ),

    # Section 4: claw-squad 深入
    (
        "Planner → Coder → Reviewer 狀態機",
        [
            "Planner：先澄清需求 → 產出 implementation plan",
            "Coder：依 plan 寫 code、跑測試、commit；可以多輪",
            "Reviewer：跑 git diff 對 plan，verdict = ship / fix / abort",
            "不通過就回 Coder，最多 N 輪後 abort 交還 human",
            "state.json 持久化每一步 → SIGINT 走同一條 finally，--resume 可續",
        ],
    ),
    (
        "Skills 系統",
        [
            "skill = 一段可複用的指引（mdx + frontmatter）",
            "apply_to glob 決定每個 agent / 檔案是否載入該 skill",
            "tag 觸發：planner 產出 task tag，相符的 skill 被 inject 到 prompt",
            "marketplace pattern：第三方 skill 透過 npm package 發布",
            "tests/ 有 ~24 個 vitest 檔，覆蓋 skill 解析與套用邏輯",
        ],
    ),
    (
        "Memory v2 — lessons.md 跨 run 學習",
        [
            "Reviewer 在 verdict 後會 propose lessons：「下次別忘記 X」",
            "human-in-the-loop 確認後寫入 .claw-squad/lessons.md",
            "下次 run 開頭把 lessons 注入到 Planner / Coder 的 user turn",
            "system prompt 不變 → cache 仍命中；個人化長記憶免費獲得",
            "上限 token 控制：超出時用 LLM 摘要而非 truncate",
        ],
    ),
    (
        "多介面：CLI / TUI / Slack / Web UI",
        [
            "CLI：node dist/cli.js run \"...\" — 自動化 / CI 友善",
            "TUI（Ink-based）：互動式檢視 plan、批准 verdict",
            "Slack bot：在頻道內 @claw-squad，跑完後回 verdict 摘要",
            "Web UI：read-only run history 瀏覽，給非工程同仁看",
            "所有介面共用同一個 orchestrator core；UI 只是 view layer",
        ],
    ),
    (
        "Multi-repo + Rollback + Resume",
        [
            "single run 可橫跨多個 repo（monorepo / submodule / 平行 repo）",
            "每個 repo 有獨立 worktree，commit 走自己的分支",
            "Rollback：abort 時自動 git reset 回起始 SHA",
            "Resume：state.json 含 phase / repo / partial diff，--resume 從中斷點繼續",
            "適用情境：跨 service 的 schema 變更、library + consumer 同步升級",
        ],
    ),
    (
        "Plugins SDK + Skills marketplace",
        [
            "Plugins SDK：對外暴露 hook 介面（preAgent / postAgent / preCommit…）",
            "第三方 plugin 用 npm package 發布；config 列名即可載入",
            "Skills marketplace：與 plugins 平行，但只給 prompt-only 擴充",
            "範例 plugins：opentelemetry exporter、Slack notify、PII scrub",
            "安全：plugin 跑在 main process；不信任的請走 claw-sandbox",
        ],
    ),

    # Section 5: 雲端化路徑
    (
        "開源核心 + Hosted SaaS",
        [
            "OSS：claudestruct + claw-squad + claw-sandbox（MIT）",
            "Hosted：multi-tenant API、GitHub App、Stripe 計費、SLO 保證",
            "兩條路共用同一份 core lib；SaaS 僅是「運維 + 計費 + 合規」加值",
            "策略避免「rug-pull」風險：核心永遠開源、商業層獨立",
            "Wave 4-8 文件詳列每個元件屬於哪一側",
        ],
    ),
    (
        "Wave 6 多租戶基底",
        [
            "資料模型：Org / User / Membership / Role（owner/admin/member）",
            "RBAC：每個 API endpoint 標 required role",
            "API key：per-Org，hash + last4 顯示，可 rotate",
            "Audit log：所有 mutation 寫不可變 append-only 表",
            "Tenancy 隔離：Postgres RLS + 應用層 org_id 雙保險",
        ],
    ),
    (
        "Wave 6 GitHub App 整合",
        [
            "webhook：pull_request opened / synchronize 觸發 claudestruct review",
            "ack comment：30 秒內回「正在分析」，避免 user 困惑",
            "verdict comment：結構化 review，分嚴重度",
            "Checks API：成 / 敗 / 警示寫入 PR check，blocked merge 整合",
            "App 安裝指令文件 + per-repo opt-in 設定檔",
        ],
    ),
    (
        "Wave 8 計費 — Stripe 整合",
        [
            "分層方案：Free / Team / Enterprise，token cap 各自不同",
            "Metered billing：每 N tokens 一個 unit，Stripe Reporter 上傳",
            "Token-cap enforcement：超過直接 503 + 友善錯誤訊息",
            "Trial：14 天免信用卡，期滿降回 Free",
            "Invoicing：Enterprise 走 PO，Stripe Billing 自動產 PDF",
        ],
    ),
    (
        "Wave 8 資料合規",
        [
            "Residency tag：每個 Org 選 region，data 不跨區",
            "CMEK：customer-managed encryption key（信封加密）",
            "PII redaction：log / metric 寫入前過 redactor",
            "Right-to-erasure：DELETE /v1/org/{id}/data 走 async job",
            "SOC 2 / ISO 27001：control mapping 文件已起草",
        ],
    ),
    (
        "Wave 8 SLO + 警示",
        [
            "/v1/slo endpoint：當前 SLO 對應 SLI 即時值",
            "Cost-regression：今日 token 成本對比近 7 日 baseline",
            "Burn-rate alerts：fast / slow 兩條，PagerDuty 路由",
            "Status page：自動由 SLI 餵入，公開頁面",
            "事件 postmortem template：blameless、含 5-why",
        ],
    ),

    # Section 6: 工程實踐
    (
        "測試策略",
        [
            "Python pytest 700+ 測試，覆蓋率 ~80%",
            "claw-squad vitest ~24 檔、~239 tests",
            "claw-sandbox go test ./...，覆蓋 rlimits 邊界",
            "外部 API mocked（responses lib / vitest fetch mock）",
            "PR 必過：lint + type-check + tests + 覆蓋率不退步",
        ],
    ),
    (
        "觀測性",
        [
            "OpenTelemetry tracing：跨 process 串成 single trace",
            "Sentry：未捕獲例外 + breadcrumb（含 cache state）",
            "結構化日誌（JSONL）：方便 jq / DuckDB / BigQuery 直接查",
            "Prometheus metrics：標準命名，Grafana dashboard 預打包",
            "本地：cs dashboard 給 dev 用；生產：標準 SRE stack",
        ],
    ),
    (
        "安全",
        [
            "claw-sandbox 的 isolation JSON：透明告知用戶哪些控制生效",
            "Secrets 抽象：env > Keychain/credential-manager > 詢問",
            "PII redaction：寫 log 前過正規式 + heuristic",
            "Dependency scan：CI 跑 pip-audit / npm audit / govulncheck",
            "Sandbox 強隔離：Docker / firejail（claw-sandbox 並非 VM）",
        ],
    ),
    (
        "CI / 文件 / 發布自動化",
        [
            "GitHub Actions：lint → type → test → build → release",
            "claw-squad pnpm pack 後丟 npm；claudestruct twine 丟 PyPI",
            "claw-sandbox cross-compile：linux/amd64、linux/arm64、darwin/*",
            "文件樹：CLAUDE.md（總覽）+ claw-squad/docs/*.md（深入）",
            "TODO.md 是 wave-by-wave roadmap，PR 會更新",
        ],
    ),

    # Section 7: 路線圖回顧
    (
        "Wave 1-9 進度速覽",
        [
            "Wave 1-3 ✅ 穩定性 / 觀測性 / DX 三線完成",
            "Wave 4 ✅ Plugins SDK + Skills marketplace 雛形",
            "Wave 5 ✅ Multi-repo + Rollback + Resume",
            "Wave 6 ⏳ 多租戶 + GitHub App 進行中",
            "Wave 7 ⏳ 觀測 / Memory v2 進行中",
            "Wave 8 ⏳ 商業化 — 計費 / 合規 / SLO 設計中",
            "Wave 9 ⏳ GX10 / 本地推論 — local cache 已落地（W9.4）",
        ],
    ),
    (
        "已交付的 PR 速覽（PR #11-#41）",
        [
            "#11-#20：observability、Prometheus、cs dashboard 系列",
            "#21-#30：multi-repo、rollback、resume、Slack / Web UI",
            "#31-#38：Skills v2、Memory v2、cache alerts、claw-squad MCP",
            "#39-#41：data residency、Wave 9-10 roadmap、local LLM cache",
            "詳見 GitHub PR list；每個 PR 有對應 TODO.md 條目可追溯",
        ],
    ),

    # Section 8: Demo + Q&A
    (
        "Demo 建議",
        [
            "場景 1：對一個小 PR 跑 cs review，觀察結構化評論",
            "場景 2：claw-squad run 「修這個 bug」 — 看 Planner→Coder→Reviewer 走完",
            "場景 3：cs dashboard 開兩個 run 的 diff，token / cache 對比",
            "場景 4：cs mcp 接 Claude Code，直接在編輯器內 /tools",
            "若時間夠：cs metrics | promtool 餵 Prometheus 即時 scrape",
        ],
    ),
    (
        "Q&A / 聯絡資訊",
        [
            "Repo：github.com/tonyandclaw/claudestruct（OSS）",
            "Issues / Discussions：歡迎開",
            "想試 Hosted SaaS：聯絡 founders（內部 Slack）",
            "貢獻：先看 CLAUDE.md + TODO.md，再挑 Wave",
            "感謝聆聽 — 接下來開放問答 🙇",
        ],
    ),
]


SECTIONS = [
    # (insert_before_index_in_SLIDES, number, title, sub)
    (0, "Section 1", "開場", "為什麼有這個 repo？60 分鐘的旅程"),
    (2, "Section 2", "三件式工具總覽", "claudestruct / claw-squad / claw-sandbox"),
    (7, "Section 3", "claudestruct 深入", "Python CLI、prompt cache、MCP"),
    (13, "Section 4", "claw-squad 深入", "Planner / Coder / Reviewer 狀態機"),
    (19, "Section 5", "雲端化路徑", "Wave 4-8：multi-tenant、GitHub App、計費"),
    (25, "Section 6", "工程實踐", "測試 / 觀測性 / 安全 / 自動化"),
    (29, "Section 7", "路線圖回顧", "已完成 vs 進行中"),
    (31, "Section 8", "Demo + Q&A", "現場操作建議與聯絡"),
]


def build(output: Path) -> None:
    prs = Presentation()
    prs.slide_width = SLIDE_W
    prs.slide_height = SLIDE_H

    # Cover
    _title_slide(prs)

    # Walk SLIDES, inject section dividers at the right positions.
    section_lookup = {idx: (num, title, sub) for idx, num, title, sub in SECTIONS}
    for i, (title, bullets) in enumerate(SLIDES):
        if i in section_lookup:
            num, st, sub = section_lookup[i]
            _section_divider(prs, num, st, sub)
        _content_slide(prs, title, bullets)

    prs.save(str(output))


if __name__ == "__main__":
    out = Path(__file__).resolve().parent.parent / "repo-intro.pptx"
    build(out)
    print(f"wrote {out} ({out.stat().st_size:,} bytes)")
