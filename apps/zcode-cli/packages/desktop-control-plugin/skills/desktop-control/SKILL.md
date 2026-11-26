---
name: desktop-control
description: 操作这台电脑上的桌面软件（Mac / Windows）：看软件界面、点击、打字、按键、滚动、拖拽、填输入框。用户让你「帮我在某个软件里点一下 / 填一下 / 看看屏幕上是什么 / 替我操作电脑」时使用。工具来自 computer MCP（Open Computer Use）。
---

# 电脑操作（desktop-control）

这台电脑就是用户正在用的真实电脑。所有动作都发生在用户自己的屏幕上。

## 工具（computer MCP）

| 工具 | 做什么 |
|---|---|
| `list_apps` | 列出正在运行 / 可操作的软件，拿到软件名 |
| `get_app_state` | 读某个软件当前窗口：界面元素树（带 `element_index` 编号）+ 截图 |
| `click` | 点元素（`element_index`）或点窗口内坐标（`x`、`y`，以截图为准） |
| `set_value` | 直接给输入框 / 下拉框写值（`element_index` + `value`），最稳 |
| `type_text` | 往当前焦点处打字（`text`） |
| `press_key` | 按键或组合键（`key`，如 `Return`、`cmd+a`、`ctrl+c`） |
| `scroll` | 滚动（元素或坐标 + 方向） |
| `drag` | 拖拽 |
| `perform_secondary_action` | 元素的次要动作（如右键菜单、展开） |

每个工具都要带 `app`（软件名，用 `list_apps` 返回的名字）。

## 做法

1. 先 `list_apps` 找到目标软件，再 `get_app_state` 看清界面。
2. 优先用最近一次 `get_app_state` 返回的 `element_index` 操作；能用 `set_value` 填的就不用打字。
3. 界面元素树里找不到目标时，才按截图坐标点（`x`、`y`）。
4. 每做完一步看返回的新界面状态，确认生效再做下一步；界面大变后重新 `get_app_state`，不要沿用旧编号。
5. Windows 上打字前先点一下要输入的文本框，让它拿到焦点，再 `type_text`。
6. 要读长文本（聊天记录、文档正文）时，`get_app_state` 加 `text_limit: 1000` 或 `"max"`。

## 必须先问用户的事

发送消息、删除、付款、提交表单、上传文件、改系统设置这类对外可见或不可撤回的动作，先说清要做什么、等用户同意再点。不去看密码管理器和与任务无关的私密内容。

## 常见问题

- **Mac 提示缺权限**（Accessibility / Screen Recording，即「辅助功能」「屏幕录制」）：告诉用户打开「系统设置 → 隐私与安全性」，在「辅助功能」和「屏幕录制与系统录音」里把弹窗提示的那一项（Open Computer Use 或 Claude 360 Code）打开，然后重开 Claude 360 Code。也可以让用户在终端运行插件自带的自查：`node "<插件目录>/scripts/launch.mjs" doctor`，它会列出缺哪个权限并弹出授权引导。
- **Mac 系统版本低于 14**：这个功能用不了（程序需要 macOS 14 及以上），升级系统才行，改权限没用。
- **Windows 读不到截图**：窗口被最小化或挡住时只返回元素树，没有截图；用元素编号操作，或请用户把窗口放到前台。
- **工具没出现**：请用户在「设置 → 插件」里确认「电脑操作」已开启，然后新开一个会话。
