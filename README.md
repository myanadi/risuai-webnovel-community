# risuai-webnovel-community
A serialized web novel community simulation for RisuAI — reputation, narrative hooks, and regular reader memory.
# 📖 Webnovel Community — RisuAI Plugin

A serialized web novel community simulation plugin for [RisuAI](https://github.com/kwaroran/Risuai). 
Treats RP sessions as serialized web novel chapters and simulates reader reactions — 
including reputation accumulation, narrative hook tracking, regular reader memory, 
and fandom glossary.

## ✨ Features

- **Reputation state machine** — Cumulative `hype` / `anti` scores per chapter
- **Narrative hook ledger** — Tracks foreshadowing through `open → promised → closed` states
- **Regular reader memory** — Distinct comment-author personas reappear across chapters
- **Fandom glossary** — Reader-coined terms (ship names, memes) accumulate organically
- **Cost-conscious design** — Local data collection + single LLM pass for comment generation
- **Configurable comment volume** — 3-20 comments per chapter, 3-15 forum posts
- **Mood control** — Bias slider (-50 cold ↔ +50 warm) and flame cap (1-5)

## ⚙️ Plugin Arguments

| Arg | Default | Description |
|---|---|---|
| `foreshadow_mode` | combined | Hook extraction: `combined` (1 call) or `split` (2 calls, more precise) |
| `body_mode` | summary | Chapter body storage: `summary` or `full` |
| `comment_count` | 8 | Comments per chapter (3-20) |
| `board_post_count` | 6 | Forum posts (3-15) |
| `mood_bias` | 0 | Mood bias (-50 to +50) |
| `flame_cap` | 3 | Anti-fan comment intensity cap (1-5) |
| `use_regulars` | 1 | Regular reader memory (0=off, 1=on) |
| `use_glossary` | 1 | Fandom glossary accumulation (0=off, 1=on) |
| `allow_nsfw` | 0 | NSFW comment allowance (0=off, 1=on) |

## 🚀 Installation

1. Download `webnovel_community_v1_2.js`
2. In RisuAI: **Settings → Plugins → Import Plugin**
3. Configure arguments in plugin settings
4. Enable

## 🛠️ Tech Stack

- Vanilla JavaScript
- RisuAI Plugin API v3.0
- State management: reputation / ledger / regulars / glossary as separate persistent stores
- Cost optimization: local-first data assembly, single LLM call per chapter
- Developed with AI-assisted workflow (Claude/GPT)

## 📝 Why This Plugin

Character-side stories often feel one-sided — the character acts, but the world rarely 
reacts back with weight. This plugin treats RP sessions as serialized web novel chapters 
and simulates the external "reader response" to character actions. As chapters accumulate, 
reputation shifts, foreshadowing builds up and resolves, and recurring reader personas 
develop their own voices — turning passive worldbuilding into a reactive narrative loop.

This plugin's "RP output → external UI reflection" design principle was later extended 
in [Side Phone](https://github.com/myanadi/risuai-side-phone), which applies the same 
pattern to a smartphone interface.

## 🇰🇷 한국어 요약

RP 회차를 웹소설 연재로 시뮬레이션하여 외부 독자 반응을 구현한 플러그인입니다. 
회차별 평판(hype/anti) 누적, 서사 복선(narrative hook)의 생명주기 추적(open→promised→closed), 
단골 독자 페르소나 기억, 팬덤 용어 적립을 상태머신 구조로 관리합니다. LLM 호출은 회차당 1회로 
최소화하는 비용 의식 설계가 적용되었습니다.

## 📜 License

MIT — see [LICENSE](LICENSE)

## 🔗 Links

- Author Portfolio: [노션 링크 박기]
- RisuAI: https://github.com/kwaroran/Risuai
