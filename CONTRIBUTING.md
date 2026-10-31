# Contributing

`master` is protected. Direct pushes to `master` are not accepted — all changes go through a Pull Request that the maintainer reviews and merges.

## Workflow

1. Fork this repository.
2. Clone your fork and create a feature branch:
   ```
   git checkout -b feature/your-change
   ```
3. Make your changes and commit them.
4. Push the branch to your fork:
   ```
   git push origin feature/your-change
   ```
5. Open a Pull Request from your fork's branch to `mu7amed-ragab/azure-devops-dashboard:master`.
6. Wait for the CI check and maintainer review before it's merged.

## Local setup

```
npm ci
npm ci --prefix web
npm run dev
```

Never commit `.env` — copy [.env.example](.env.example) instead and fill in your own values locally.
