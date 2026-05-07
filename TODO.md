# Project TODOs

## Features
- [x] **Multi-user session isolation in group chats**: Allow users to have their own private sessions even in groups.
- [ ] **Dedicated Web Search Tool**: Implement a tool for the agent to search the web (e.g., using Google Search API or Tavily).
- [x] **Enhanced Autopilot Control**: Add ability to pause/resume and better status reporting.
- [x] **Bot Log Command**: Add a `/logs` command to view recent bot logs directly in Telegram.
- [ ] **Configuration via Telegram**: Allow authorized users to change configuration settings via a UI.
- [ ] **Better Project Management UI**: Use inline buttons for project exclusion and manual addition.

## Infrastructure & DX
- [x] **Docker Support**: Create a Dockerfile and docker-compose.yml for easy deployment.
- [ ] **Expand Test Coverage**: Add integration tests for the full message loop and media handling.

## Done
- [x] Initial Review and Project Roadmap Setup
- [x] Implemented `/logs` command to view recent bot logs.
- [x] Added Docker support with Dockerfile and docker-compose.yml.
- [x] Implemented multi-user session isolation in group chats (using `chatId:userId` keys).
- [x] Enhanced Autopilot with pause/resume and better status reporting.
