# Claude Usage — เริ่มใช้ใน 3 นาที (ฉบับภาษาไทย)

ดู limit ของ Claude (session 5 ชม. / รายสัปดาห์ / รายโมเดล) เวลา reset ที่แน่นอน
burn rate และประวัติย้อนหลังทั้งหมด — รันบนเครื่องคุณเอง ข้อมูลไม่ออกจากเครื่อง

![dashboard](https://raw.githubusercontent.com/gipsic/claude-usage/main/docs/images/dashboard.gif)

## ต้องมีอะไรบ้าง

- **Node.js 22 ขึ้นไป** (เช็คด้วย `node -v`; ถ้าไม่มี: `brew install node`)
- ใช้ Claude Code หรือ Claude desktop app อยู่แล้ว (เครื่องมือนี้อ่านข้อมูลจากตรงนั้น)
- macOS / Linux / Windows (Windows ยังเป็น beta — ผ่าน CI แต่ยังไม่มีใครทดสอบบนเครื่องจริง)

## ติดตั้ง

**macOS — วิธีที่ง่ายที่สุด**

```bash
brew tap gipsic/tap && brew install claude-usage
claude-usage install-daemon      # ให้รันเป็น background ตอน login
claude-usage serve --open        # เปิด dashboard
```

**macOS / Linux — ตัวติดตั้งอัตโนมัติ** (ลง PATH + service + เปิด dashboard ให้เสร็จในคำสั่งเดียว)

```bash
curl -fsSL https://raw.githubusercontent.com/gipsic/claude-usage/main/install.sh | sh
```

**ทุก platform — ผ่าน npm**

```bash
npm install -g @gipsic/claude-usage
claude-usage install-daemon
claude-usage serve --open
```

> **ครั้งแรก macOS อาจเด้งถามว่า "node wants to access Claude Code-credentials"**
> กด **Always Allow** — คือการอ่าน token login ของ Claude Code ในเครื่องคุณเอง
> เพื่อไปถาม Anthropic ว่าใช้ไปกี่ % ไม่มีการส่งไปที่อื่น และไม่มีการเขียนทับอะไรทั้งสิ้น

## ใช้งาน

| อยากทำอะไร | ทำยังไง |
|---|---|
| ดู dashboard | เปิด **http://127.0.0.1:4778** |
| ดูเร็ว ๆ ใน terminal | `claude-usage now` |
| ดูสด ๆ | `claude-usage watch` |
| ให้ % และเวลา reset ตรงกับแอปเป๊ะ ๆ | กด **Accounts → Sign in with browser** (หรือ `claude-usage login --web`) |
| ตั้งเตือนตอนใกล้ชน limit | `claude-usage alerts` — ดู/แก้ได้จาก dashboard → **Alerts → Settings** ด้วย |
| ขอเงียบสักพัก (ไม่ปิดทั้งระบบ) | `claude-usage alerts mute 2h` หรือ `alerts quiet 22:00-08:00` |
| **อัปเกรดแล้วตัวเลขไม่เปลี่ยน** | `claude-usage restart` — ตัวที่รันอยู่ยังเป็นโค้ดเก่าจนกว่าจะ restart |
| ขึ้น menu bar (macOS) | ติดตั้ง [SwiftBar](https://swiftbar.app) แล้ว `ln -s "$(brew --prefix)/opt/claude-usage/libexec/bin/claude-usage.1m.sh" ~/Library/Application\ Support/SwiftBar/` |
| export CSV | ปุ่ม Export ใน dashboard หรือ `claude-usage export -o usage.csv` |
| เช็คว่าทุกอย่างโอเคไหม | `claude-usage doctor` |
| เลิกใช้ | `claude-usage uninstall-daemon` แล้วลบโฟลเดอร์ |

## ตัวเลขมาจากไหน

- **% limit และเวลา reset** — มาจาก Anthropic โดยตรง (ค่าเดียวกับที่เห็นใน Claude app
  รวมทุกอุปกรณ์และ claude.ai) ถ้า token ของ Claude Code หมดอายุ ระบบจะใช้ token ของ
  Claude desktop app แทนโดยอัตโนมัติ — ตัวเลขยัง live เหมือนเดิม ไม่ต้องทำอะไร
  ถ้าไม่มี token ที่ใช้ได้เลย จะถอยไปอ่าน cache ของ desktop app และติดป้าย **inferred**
- **token / ค่าใช้จ่าย / รายโปรเจกต์** — อ่านจาก transcript ของ Claude Code ในเครื่องนี้เท่านั้น
  ("ค่าใช้จ่าย" คือราคาถ้าจ่ายแบบ API ไว้เทียบสัดส่วน ไม่ใช่บิลจริงของ subscription)
- อะไรที่เป็นการประมาณจะติดป้าย `estimated` / `inferred` เสมอ ไม่มีการเอาค่าเดาไปแสดงปนกับค่าจริง

อยากรู้ลึกว่าไฟล์พวกนี้หน้าตายังไง อ่าน
[Where Claude Code keeps your usage numbers](docs/blog/where-claude-code-keeps-your-usage.md)

## เทียบกับ ccusage

[ccusage](https://github.com/ccusage/ccusage) อ่าน usage จาก agent CLI ได้ 16 ตัว
(Claude Code, Codex, Gemini, Copilot ฯลฯ) แล้วสรุปเป็นรายงานใน terminal รันด้วย `npx`
ไม่ต้องติดตั้ง — ถ้าโจทย์คือ "อยากรู้ค่าใช้จ่ายรวมจากหลายเครื่องมือ" ให้ใช้ตัวนั้น ดีกว่า

ตัวนี้ตอบอีกคำถามหนึ่ง: **เหลือ limit เท่าไหร่ reset ตอนไหนแน่ ๆ และย้อนหลังเป็นเดือนได้ไหม**
โดยถาม endpoint ของ Anthropic ด้วย login ที่คุณมีอยู่แล้ว แลกมากับการต้องมี credential
และ background service ซึ่ง `npx` ไม่ต้องใช้ ทั้งคู่เป็น MIT อ่านอย่างเดียว
เก็บข้อมูลไว้ในเครื่อง และใช้พร้อมกันได้

## มีปัญหา / อยากช่วยพัฒนา

เปิด issue ที่ https://github.com/gipsic/claude-usage/issues — ถ้าตัวเลขไม่ตรงกับแอป
แนบภาพหน้า Usage ในแอป + ผล `claude-usage doctor` มาด้วยจะช่วยได้มาก
โค้ดเป็น MIT ยินดีรับ PR ทุกขนาด ดู `CONTRIBUTING.md`
