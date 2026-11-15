module.exports = {
  apps: [
    {
      name: 'alditalk-extender',
      script: 'dist/index.js',
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork',
      watch: false,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 30_000,
      max_memory_restart: '400M',
      kill_timeout: 10_000,
      time: true,
      env: {
        NODE_ENV: 'production',
      },
      out_file: './logs/out.log',
      error_file: './logs/error.log',
      merge_logs: true,
    },
  ],
};
