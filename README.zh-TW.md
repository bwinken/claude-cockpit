# claude-cockpit

[English](README.md)

**cockpit** 是一個 [Claude Code mod](https://code.claude.com/docs/en/plugins/mods/overview)，讓你即時看到 session 正在做什麼。終端機和 Desktop app 都能用，不綁定任何模型、provider 或 gateway。

## 安裝

需要 Claude Code **2.1.292** 以上。在終端機的 session 裡執行：

```text
/plugin install cockpit --marketplace bwinken/claude-cockpit
```

回答 `y` 加入 marketplace，再選 user scope。cockpit 會立即生效，同一台機器上 Desktop app 開的 session 也會載入。

剛開的 session 不會顯示任何東西：Claude 呼叫 tool 時才會出現 spinner 和摘要；timeline pane 要用 `/cockpit` 打開（或設定 `timelineAutoOpen` 每次自動打開）。

不安裝、直接試用本機的 checkout：`claude --plugin-dir ./claude-cockpit`。

## 功能

### Round 追蹤

spinner 會顯示目前第幾輪、這輪跑幾個 tool call。turn 結束時，用一行淡色摘要依 tool 統計。

![spinner 顯示 round，結束時的摘要](docs/images/rounds.png)

一輪（round）是模型一次回應裡要求的所有 tool call，不計 subagent。在 Desktop app 和 `claude -p` 裡，摘要會是回答下方的一行。

### Timeline pane

`/cockpit` 打開一個 pane，顯示整個 session 的狀況：context 用量、turn 數、tools、skills、已連線的 MCP server、tokens、改過的檔案，接著每輪一行，從 #1 往下。`/cockpit close` 關閉。想每次開 session 都自動打開，設定 `timelineAutoOpen`；終端機寬度不到 144 欄（自己開過一次後為 110 欄）時，pane 會等到終端機變寬或你執行 `/cockpit` 才顯示。

![停靠在對話旁的 timeline pane](docs/images/timeline.png)

compact 後會畫一條 `── compacted ──` 分隔線，編號重新開始。`/clear`、`/resume`、`/branch` 會從空的 timeline 開始。

### Edited files 列

在 git repo 裡，輸入框上方會顯示上一輪改了什麼，包含透過 Bash 做的修改。**Show files** 列出每個檔案；用 ctrl+x tab 可以從鍵盤移到這一列。不在 git 裡就不顯示。

![展開後的 Edited files 列](docs/images/band.png)

### Tool guard

guard 會擋下明顯具破壞性的呼叫，並告訴 Claude 該改用什麼方式。一般的呼叫它不會過問，只有在 **auto mode 擋下一個呼叫**時才會問你，並顯示完整參數讓你決定要不要執行這一次。

![auto mode 擋下呼叫後，cockpit 詢問是否執行一次](docs/images/auto.png)

| 內建規則 | 擋下 |
| :- | :- |
| `rm-rf` | 各種寫法的 `rm -rf`，以及 PowerShell 的 `Remove-Item -Recurse -Force` |
| `git-reset-hard` | `git reset --hard` |
| `git-push-force` | `git push --force`、`-f` 或 `+` refspec（`--force-with-lease` 不擋） |
| `write-outside-project` | 寫入專案外的 Edit/Write；暫存目錄、`~/.claude`、`/add-dir` 與 `additionalDirectories` 除外 |

自訂規則寫在 `~/.claude/cockpit-rules.json`。專案裡的 `.claude/cockpit-rules.json` 只能新增 `deny` 規則。

```json
{
  "disable": ["git-push-force"],
  "deny": [{ "id": "no-publish", "tool": "Bash", "pattern": "\\bnpm\\s+publish\\b", "reason": "CI publishes" }],
  "allow": [{ "id": "tests", "tool": "Bash", "pattern": "^npm test$" }],
  "writableRoots": ["~/notes"]
}
```

每個決定都會記在對話裡，也會寫進 `~/.claude/plugins/store/` 的稽核紀錄（保留最新 500 筆）。guard 出錯或逾時時，該呼叫會被拒絕。

## 設定

在 `/config` 修改，或寫在 `~/.claude/settings.json` 的 `pluginConfigs["cockpit@claude-cockpit"].options` 底下。

| 選項 | 預設 | |
| :- | :- | :- |
| `roundTrace` | `true` | Round 追蹤 |
| `roundTraceMaxTools` | `5` | 摘要列出幾個 tool（1–20） |
| `timeline` | `true` | Timeline pane 與 `/cockpit` |
| `timelineAutoOpen` | `false` | 每次開 session 自動打開 pane |
| `editedFiles` | `true` | Edited files 列（關閉時完全不跑 git） |
| `gate` | `true` | Tool guard |
| `gateAutoModePrompt` | `true` | auto mode 擋下時詢問 |
| `gateRulesFile` | `~/.claude/cockpit-rules.json` | 自訂規則檔 |
| `gateDisabledRules` | `[]` | 要關閉的內建規則 id（只能在 settings.json 設定） |

## 限制

- guard 讀的是指令文字，防的是無心之過，擋不住刻意繞過（`eval`、腳本、Bash 重新導向）。啟動時用 `--add-dir` 加的目錄 mod 看不到，請列在 `writableRoots`。
- 組織管理的 `deny` 規則和 managed hook 優先於 cockpit，「Run it once」無法蓋過它們。
- 改過的檔案由 git 判斷：turn 進行中手動改的也算進該輪，rename 會顯示成刪除＋新增，超過 2 MiB 的未追蹤檔案顯示為 `large file`、沒有行數。
- 已在 Linux 的真實終端機 session 測過；CI 在 Linux、macOS、Windows 跑測試。Desktop app 還沒在真實 session 中確認過。
- 在終端機以外，Claude Code 會在摘要那行前面加上所有掛在 turn 結束事件上的 mod 名稱。

## 組織管理 Claude Code 時

組織可以用 [managed settings](https://code.claude.com/docs/en/plugins/mods/admin) 限制 mod。cockpit 沒載入時，檢查以下設定：

| Managed setting | 影響 |
| :- | :- |
| `allowManagedModsOnly`（內建 guard 的選項） | 只載入組織自己的 mod |
| `allowManagedHooksOnly` | 只執行組織的 mod 和 hook |
| `disableAllHooks` | 所有 mod 都不執行 |
| `disableSideloadFlags` | `--plugin-dir` 會被拒絕 |
| `strictKnownMarketplaces` | 可能無法加入這個 marketplace |

`claude --debug` 會在 log 中記錄 mod 被拒絕的原因。`claude --safe-mode` 會關閉所有 mod。

## 開發

```bash
claude plugin validate --strict .
claude plugin test .
tsc -p .   # 需要 Claude Code 先載入過這個資料夾一次
```

CI 在 Linux、macOS、Windows 跑 validate 和 test。發布時要改 `.claude-plugin/plugin.json` 的 `version`，已安裝的版本只有在它改變時才會更新（`claude plugin update cockpit@claude-cockpit`，再 `/reload-plugins`）。改了 mod 卻沒改版本的 pull request，CI 會失敗。文件與型別宣告不一致的地方記在 `NOTES.md`。

## License

MIT
