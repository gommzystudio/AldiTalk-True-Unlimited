module.exports = {
  apps: [{
    name: 'alditalk-extender',
    script: 'dist/index.js',
    instances: 1,
    exec_mode: 'fork',
    watch: false,
    autorestart: true,
    max_restarts: 10,
    restart_delay: 30000, // 30 seconds delay before restart
    env: {
      NODE_ENV: 'production'
    },
    log_file: './logs/combined.log',
    out_file: './logs/out.log',
    error_file: './logs/error.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    merge_logs: true,
    // Cron pattern to restart the app (run once daily at 8 AM)
    cron_restart: '0 8 * * *',
    // Kill timeout
    kill_timeout: 5000
  }]
};

