# 量潮 Radar｜GitHub Pages 用户主页

部署后固定地址：

`https://你的GitHub用户名.github.io/`

## 一次性部署

1. 在 GitHub 创建一个公开仓库，仓库名必须是 `你的GitHub用户名.github.io`。
2. 把本目录全部文件推送到 `main` 分支。
3. 如果 GitHub Pages 没有自动启用，进入仓库 `Settings` → `Pages`，选择 `Deploy from a branch`，分支 `main`，目录 `/ (root)`，保存。
4. 等待 1-3 分钟，固定网址即可访问。

## 自动更新

`.github/workflows/refresh-dashboard.yml` 每天北京时间 16:10 自动运行：

- 抓取公开行情、板块、个股日 K、主力资金流和财经快讯。
- 重新计算板块强度与观察清单。
- 更新 `data/dashboard.json` 并提交。
- GitHub Pages 自动发布最新内容。

也可以在仓库 `Actions` 页面手动运行 `Refresh dashboard snapshot`。

## 风险声明

页面是基于公开数据的条件式观察工具，不构成投资建议、收益承诺或买卖指令。股市有风险，决策需独立判断。
