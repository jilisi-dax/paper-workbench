论文工作台
===========

用 Edge 或 Chrome 打开「论文阅读.html」，可以离线阅读 PDF 和记录笔记。

首次使用，在此目录运行

    powershell.exe -NoProfile -ExecutionPolicy RemoteSigned -File ".\temp\同步论文目录.ps1"

同步脚本首次运行时会用 catalog.example.json 初始化 data/catalog.json。

资料目录
--------

• data/新论文临时区/　待入库的新 PDF 统一放这里。
• data/论文/　保存已入库的 PDF。原件按原文件名存入「原始pdf」，阅读副本按分类和标题存放。
• data/笔记/　保存阅读笔记和随想录的备份。
• data/书籍报告/　存放书籍、报告及其他参考资料。

按「阅读工作台说明.txt」对临时区里的论文去重、归档，再更新 data/catalog.json、运行同步脚本并刷新网页。确认工作台能打开入库版本后，清理临时区中已处理的副本。同步脚本负责校验目录和生成缓存，入库步骤需要先完成。

Git 通过四个空的 .gitkeep 文件保留上述目录。论文、笔记、书籍报告、本地目录 JSON 和 cache/ 内的文件均由 Git 忽略。
