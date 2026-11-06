# 商店上架资料

Chrome 应用商店和 Edge 加载项填表时照抄。截图在同一目录。

## 基本信息

- 名称：S1 Lumen
- 分类：工具 / 外观
- 语言：中文（简体）
- 可见性：不公开（Unlisted）

## 简短说明

Stage1st 论坛的第三方界面：亮暗主题、S1 原版配色、侧栏布局、阅读位置和长帖工具，切换页面不闪烁。

## 详细说明

S1 Lumen 重新设计了 Stage1st 论坛（stage1st.com/2b）的界面。这是第三方扩展，与论坛官方无关。

- 浅色、深色和跟随系统，浅色可选 S1 原版配色
- 侧栏布局，切换页面不闪烁
- 记住阅读位置，列表里显示新回复，一键接着读
- 引用跳转和返回、楼层拖动条、图片和附件集中查看
- 屏蔽用户和关键词，NSFW 帖子图片默认遮挡
- 查看被屏蔽楼层的内容（需要论坛账号）

隐私：扩展没有自己的服务器，只向论坛发请求。查看被屏蔽楼层时会用你的账号密码向论坛 App 接口换一个凭证，密码不保存。详见隐私政策。

## 单一用途

改善 Stage1st 论坛的阅读和使用体验。

## 权限说明

- `storage`：保存设置、屏蔽名单和论坛 App 接口的登录凭证。
- 内容脚本匹配 stage1st.com 和 saraba1st.com：在这两个论坛域名上替换界面样式、添加阅读功能。

## 远程代码

不使用远程代码。

## 数据使用

需要勾选：

- 身份验证信息：账号密码只发给 Stage1st 论坛，用于换取其 App 接口凭证，不保存；凭证保存在本机。
- 网站内容：在页面上处理论坛内容，不离开本机。

三项声明都勾选：不向第三方出售或转让；不用于与单一用途无关的目的；不用于判断信用或贷款。

## 给审核员看的字段（英文版）

商店页面的文案用中文。下面这些字段是审核员读的，用英文更稳妥。

Single purpose:

> Improves the reading and browsing experience of the Stage1st forum (stage1st.com/2b) with a redesigned interface and reading tools.

Permission justification, `storage`:

> Saves the user's settings and block list, and a token for the forum's own App API on this device.

Host permission justification (content script on stage1st.com and saraba1st.com):

> The extension only runs on the two domains of the Stage1st forum, where it restyles the pages and adds reading features.

Remote code:

> No. All code is included in the package.

Data usage, authentication information:

> When the user logs in to the forum with the checkbox on the login form ticked, or enters a password to view a hidden post, the user name and password are sent over HTTPS to the forum's own App API at stage1st.com to obtain a token. The password is never stored. The token stays in chrome.storage.local on the device and is only sent to the forum. Nothing is sent to the developer or to any third party.

Test instructions:

> No account is needed to review the interface and settings: open https://stage1st.com/2b/forum-6-1.html and any thread, and use the toolbar popup. Viewing hidden posts requires a Stage1st account, which we cannot provide. That feature only appears on posts marked as hidden by the forum.

## 隐私政策链接

需要一个公开网址。仓库公开后可以用：

https://github.com/shqingda/s1-lumen/blob/main/PRIVACY.md
