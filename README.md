中文 | [English](https://github.com/610la/dsh-notification-center/blob/main/README.en.md)

# DSH 通知中心插件

> ⚠️ 本插件为第三方社区插件，**非 DeepSeek Harness 官方出品**。

DSH 的**通知中心**：对话、任务完成后，自动在浏览器弹出**系统通知**并播放**提示音效**——切到别的窗口也不会错过。

## 功能一览

- 🔔 **浏览器系统通知** + **提示音效**（内置 21 种，全部可换）
- 🖥️ **原生系统通知**：打包成桌面应用（Electron/Tauri）时自动改用宿主进程的原生系统通知，不受壳的权限限制
- 🎚️ **每个事件独立配置**：通知开关、音效类型、自定义音效文件/URL、音量
- 🚫 手动停止/打断生成**默认不通知**；报错、超长、被阻塞会提醒
- ⏰ 模型请求权限/批准时**立即提醒**（不受冷却限制）
- 💾 设置自动保存，刷新不丢失

## 安装（DSH）

一条命令即可（推荐）：

```bash
dsh plugin --profile web add @lyhalal/dsh-notification-center
```

重启 DSH 后生效，浏览器端自动加载，无需其他配置。

> 手动方式（等价）：在 DSH 项目目录 `npm install @lyhalal/dsh-notification-center`，
> 并在 host 的 `cordis.yml` 的 `plugins` 下加一行：
> ```yaml
> plugins:
>   - from: '@lyhalal/dsh-notification-center'
> ```

## 使用

- **输入栏左侧 🔔**：快速开关「浏览器通知 / 完成音效」、授权通知权限、测试
- **设置 → 通知中心**：完整配置
  - **总开关**：浏览器通知、完成音效、通知权限、浏览器通知测试、冷却间隔
  - **事件**：对话完成、子任务完成、Workflow 完成、后台任务完成、等待批准
  - **停止原因**：报错停止、超长截断、被阻塞、其他原因、手动停止/打断
- 每个分类点开后可设置：**音效类型**（21 种内置 / 静音 / 自定义文件 / 自定义 URL）、**音量**、**开关**；选择音效时立即试听

## 系统通知

- 在**浏览器**里使用时，走网页系统通知（首次需在地址栏授权）
- 打包成**桌面应用**（Electron/Tauri）后，自动改用**宿主进程的原生系统通知**（Windows 通知中心 / macOS 通知中心 / Linux notify-send），显示名为 `DeepSeek Harness`，**不依赖浏览器权限**，即使壳禁用了网页通知也能正常弹
- 打包环境下设置里的「通知权限/授权」会自动隐藏（原生通知无需浏览器授权）

## 提示

- 浏览器环境首次使用请**允许通知权限**：点「授权」或点「测试」
- 音效需要页面内有**任意一次点击**后才会响（浏览器自动播放策略）
- 手动停止/打断生成**默认不通知**，需要的话可在「停止原因 → 手动停止/打断」打开

## 卸载

```bash
dsh plugin --profile web remove @lyhalal/dsh-notification-center
```

## 链接

- npm 主页：https://www.npmjs.com/package/@lyhalal/dsh-notification-center
- GitHub 仓库：https://github.com/610la/dsh-notification-center
