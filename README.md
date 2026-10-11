# 量潮 Radar｜A股量价雷达

**永久地址：** https://xieyu1111.github.io/xuangu/

**GitHub 仓库：** https://github.com/xieyu1111/xuangu

网站根据公开行情、板块资金流、个股日 K、近 10 日主力资金和财经快讯，筛选下一交易日值得重点观察的板块与个股，区分“板块龙头”“低位蓄势”和“趋势共振”。

## 自动更新

`.github/workflows/refresh-dashboard.yml` 每天北京时间 16:10 自动运行：

- 抓取最新指数、行业板块、个股日 K 和主力资金流。
- 更新新闻情绪与题材催化。
- 重新计算板块强度和观察清单。
- 更新 `data/dashboard.json` 并提交到仓库。
- GitHub Pages 自动发布最新页面。

也可以在 GitHub 仓库的 `Actions` 页面手动运行 `Refresh dashboard snapshot`。

## 风险声明

本页面仅用于量化研究和信息整理，不构成证券投资咨询、投资建议、买卖指令或收益保证。股市有风险，决策需独立判断。
