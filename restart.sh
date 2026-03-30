#!/bin/bash

# 1. PM2 プロセスのクリーンアップ
# 既存のプロセスを削除し、古いログをクリアします
pm2 delete all
pm2 flush

# 2. アプリケーションの起動
# ecosystem.config.js を使用して起動し、設定を保存します
pm2 start ecosystem.config.js
pm2 save

# 3. ログの確認
# 起動が成功したか確認するためにログを表示します（Ctrl+Cで抜けられます）
pm2 logs spoon-manager
