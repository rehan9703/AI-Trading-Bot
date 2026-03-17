# Deploy Guide for Railway

1. Push code to GitHub (without `.env` file). Use `.dockerignore` and `.gitignore` to keep secrets safe.
2. Go to [railway.app](https://railway.app) -> New Project -> Deploy from GitHub repo.
3. Add environment variables in Railway dashboard (all keys from `.env.example`).
4. Railway auto-detects `Dockerfile` from the repo or the `cloud/` folder, based on `railway.json` or you can configure it explicitly.
5. Get public URL for the dashboard from Railway.
6. Monitor logs in the Railway dashboard.
