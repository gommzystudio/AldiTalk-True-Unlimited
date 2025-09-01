# AldiTalk True Unlimited 🚀

**Turn your AldiTalk "unlimited" plan into REAL unlimited data!** 

Automatically book free 1GB data packages every 15 minutes to bypass the throttling limit.

## 📋 Requirements

- Node.js 14+
- Chrome/Chromium browser
- PM2 (installed globally)

## 🛠️ Installation

1. **Clone and install dependencies:**
```bash
cd /path/to/AldiTalkExtender
npm install
npm install -g pm2
```

2. **Create `.env` file with your credentials:**
```bash
# .env
USERNAME=your_phone_number
PASSWORD=your_password
```

3. **Build and start the service:**
```bash
npm run build
pm2 start ecosystem.config.js
pm2 save
pm2 startup
```

## 📊 PM2 Management

```bash
# View status
pm2 status

# View logs
pm2 logs alditalk-extender

# Restart service
pm2 restart alditalk-extender

# Stop service
pm2 stop alditalk-extender
```
