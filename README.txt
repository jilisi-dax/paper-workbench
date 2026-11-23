论文工作台
===========

用 Edge 或 Chrome 打开「论文阅读.html」，可以离线阅读 PDF 和记录笔记。

首次使用，在此目录运行

    powershell.exe -NoProfile -ExecutionPolicy RemoteSigned -File ".\temp\同步论文目录.ps1"

同步脚本会用 catalog.example.json 初始化空资料库。将 PDF 放入 data/论文，按「阅读工作台说明.txt」填写 data/catalog.json，再运行同步脚本并刷新网页。

个人资料集中在 data/，包括目录、分类、论文、笔记备份与参考材料。应用使用 cache/ 下的离线目录和 PDF 缓存，两者均可通过同步脚本生成。工程仓库只收录白名单内的文件，data/ 和 cache/ 由本机独立管理。
