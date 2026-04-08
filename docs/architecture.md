# Architecture

系统由 QQ 适配层、桥接编排层、Codex 桌面驱动层和 SQLite 存储层组成。
第一版通过桌面 UI 自动化驱动 Codex，不把控件语义泄露给编排层。
