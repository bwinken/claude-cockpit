# claude-cockpit

[English](README.md)

**cockpit** 是一個 [Claude Code mod](https://code.claude.com/docs/en/plugins/mods/overview)，讓 session 的執行過程在發生的當下就看得見。終端機與 Claude Code Desktop app 都能使用，不限定任何模型、provider 或 gateway。

<!-- 截圖：round 進行中的 spinner，例如「Sauteing… round 2 · parallel processing 3 tool calls」 -->
> 📷 _截圖佔位：spinner 上的 round 追蹤_

<!-- 截圖：回答下方的摘要列 -->
> 📷 _截圖佔位：每輪摘要列_

## 需求

- Claude Code **2.1.292** 以上。Plugin manifest 沒有 Claude Code 會強制執行的最低版本欄位，所以 cockpit 在 session 開始時檢查版本，太舊會顯示警告。
- mod 功能必須開啟。Claude Code 2.1.286 起預設開啟，但組織可能把它關掉，見[若你的組織管理 Claude Code](#若你的組織管理-claude-code)。

## 安裝

在終端機的 Claude Code session 提示列輸入：

```text
/plugin install cockpit --marketplace bwinken/claude-cockpit
```

回答 `y` 加入 marketplace，再選擇範圍。第一個選項是 user scope，選它會讓 cockpit 在每個 session 都載入。安裝後立即生效，不必重新啟動。

這個指令只能在終端機 session 使用。以 user scope 安裝後，同一台機器上由 Desktop app 啟動的 session 也會載入 cockpit。

不安裝、直接試用本機的 clone：

```bash
git clone https://github.com/bwinken/claude-cockpit
claude --plugin-dir ./claude-cockpit
```

## 功能

每個功能都可以單獨開關。在 `/config` 修改（每個選項各占一列），或在 `~/.claude/settings.json` 的 `pluginConfigs` 底下修改。使用 `--plugin-dir` 時，key 是 `cockpit@inline`。

### Tool call round 追蹤

**round** 是 Claude 在同一次 model 回應中發出的所有 tool call。只計算主對話，subagent 的請求不列入。

- **round 進行中**：spinner 保留原本的動畫、字詞與計數器，cockpit 在後面加上這一輪正在做的事，例如 `Sauteing… round 2 · parallel processing 3 tool calls` 或 `round 3 · processing 1 tool call`。數量隨 model 回應的串流增加。兩輪之間，model 還在產生下一個回應時，spinner 不加任何內容。終端機寬度不到 90 欄時省略 round 編號。
- **turn 結束時**：cockpit 加上一行簡短摘要，列出 round 數、tool call 總數與各工具的呼叫次數。在終端機中，它是 Claude Code 結束行下方的一行灰字，例如 `✻ Crunched for 3s · done 12:37 PM` 下面接著 `⎿  2 rounds · 5 tool calls (Read ×3, Bash ×2)`。Desktop app、同時有其他 app 連上的 session，以及 `claude -p` 沒有這條結束行，所以在那些環境中，摘要改為回答下方的一行並附上耗時，例如 `2 rounds · 5 tool calls (Read ×3, Bash ×2) · 3.2s`。沒有呼叫任何工具的 turn 不加摘要；被中斷的 turn 會在摘要結尾標示 `interrupted`。MCP 工具顯示為 `server:tool`。

| 選項 | 預設 | 作用 |
| :- | :- | :- |
| `roundTrace` | `true` | 開關 round 追蹤 |
| `roundTraceMaxTools` | `5` | 摘要列出的工具名稱數量（依使用次數排序），範圍 1 到 20，其餘計為 `+k more` |

## 已知限制

- **round 的邊界取決於 model 的回應。** cockpit 計算每次回應裡的 `tool_use` block。由 API 端自己執行的工具（例如 advisor）不列入計算。
- **Desktop app。** 測試只確認 cockpit 交給 Desktop spinner 的樹，app 實際怎麼畫出這段文字，要在真實 session 中才看得到。在 Desktop app 中，spinner 的字詞描述的是目前的步驟，而不是動畫用的動詞。
- **檢視 subagent 時。** spinner 不會標明它屬於哪個 loop，所以你在檢視 subagent 的 transcript 時，那裡的 spinner 顯示的是主對話的 round。
- **終端機以外的摘要標籤。** 摘要以回答下方一行呈現時，Claude Code 會用所有掛在 turn 結束事件上的 mod 名稱標示這一行，例如 `cockpit+cc-plugin-agents-md:`，mod 無法改變這個標籤。
- **對應結束行的方式。** Claude Code 的結束行不會標明它屬於哪一輪，所以 cockpit 以毫秒為單位的耗時來對應。兩輪的耗時若完全相同，會顯示同一份摘要。

## 若你的組織管理 Claude Code

mod 以使用者的權限執行，沒有沙箱，所以組織可以用 [managed settings](https://code.claude.com/docs/en/plugins/mods/admin) 限制 mod。cockpit 沒有載入時，可能是下列設定造成的：

| Managed setting | 對 cockpit 的影響 |
| :- | :- |
| 內建 guard 的 `allowManagedModsOnly`（`pluginConfigs["cc-plugin-sec-default@builtin"].options`） | 只載入組織自己的 mod，cockpit 不會載入 |
| `allowManagedHooksOnly` | 只有組織的 mod 與 hook 會執行 |
| `disableAllHooks` | 所有 mod 和 hook 都不執行 |
| `disableSideloadFlags` | 啟動時拒絕 `claude --plugin-dir` |
| `strictKnownMarketplaces` 等 marketplace 限制 | 決定這個 repo 能不能被加為 marketplace |

這些設定使用者無法覆蓋。要查看 cockpit 沒有載入的原因，以 `claude --debug` 啟動 session，在 debug log 中找類似 `refused by cc-plugin-sec-default: … (allowManagedModsOnly)` 的行。以 `claude --safe-mode` 啟動會關閉所有已安裝的 mod，可用來確認問題是否來自 mod。

## 開發

```bash
claude plugin validate --strict .   # manifest、hooks module、state contract
claude plugin test .                # 以 engine 執行 tests/*.test.ts
tsc -p .                            # Claude Code 載入過這個資料夾一次之後（會寫入 .claude-plugin/types/）
```

`NOTES.md` 記錄 mods 文件與這個 Claude Code build 的 declarations 不一致的地方。

## 授權

MIT
