# Claude Usage — เริ่มใช้ใน 3 นาที (ฉบับภาษาไทย)

ดู limit ของ Claude (session 5 ชม. / รายสัปดาห์ / รายโมเดล) เวลา reset ที่แน่นอน
burn rate และประวัติการใช้ย้อนหลังทั้งหมด — รันบน Mac ของคุณเอง ข้อมูลไม่ออกจากเครื่อง

## ต้องมีอะไรบ้าง

- macOS + **Node.js 22 ขึ้นไป** (เช็คด้วย `node -v`; ถ้าไม่มี: `brew install node`)
- ใช้ Claude Code หรือ Claude desktop app อยู่แล้ว (ตัวเครื่องมืออ่านข้อมูลจากตรงนั้น)

## ติดตั้ง (คำสั่งเดียว)

```bash
curl -fsSL https://raw.githubusercontent.com/gipsic/claude-usage/main/install.sh | sh
```

หรือแบบ clone เอง:

```bash
git clone https://github.com/gipsic/claude-usage ~/Applications/claude-usage
~/Applications/claude-usage/install.sh
```

ตัวติดตั้งจะ: ใส่คำสั่ง `claude-usage` ลง PATH → ติดตั้งเป็น service ที่เปิดตอน login →
สร้าง `Claude Usage.app` ใน ~/Applications → เปิด dashboard ให้

> **ตอนแรกอาจมี popup ของ macOS ถาม "node wants to access Claude Code-credentials"**
> กด **Always Allow** — นี่คือการอ่าน token login ของ Claude Code ในเครื่องคุณเอง
> เพื่อไปถาม Anthropic ว่าใช้ไปกี่ % (ไม่มีการส่งไปที่อื่น)

## ใช้งาน

| อยากทำอะไร | ทำยังไง |
|---|---|
| ดู dashboard | เปิด **http://127.0.0.1:4778** หรือกด `Claude Usage.app` |
| ดูเร็ว ๆ ใน terminal | `claude-usage now` |
| ดูสด ๆ | `claude-usage watch` |
| ให้ % และเวลา reset ตรงกับแอปเป๊ะ ๆ | กด **Accounts → Sign in with browser** ใน dashboard (หรือ `claude-usage login --web`) |
| ขึ้นบน menu bar | ติดตั้ง [SwiftBar](https://swiftbar.app) แล้ว `ln -s ~/Applications/claude-usage/bin/claude-usage.1m.sh ~/Library/Application\ Support/SwiftBar/` |
| export CSV | ปุ่ม Export ใน dashboard หรือ `claude-usage export -o usage.csv` |
| เช็คว่าทุกอย่างโอเคไหม | `claude-usage doctor` |
| เลิกใช้ | `claude-usage uninstall-daemon` แล้วลบโฟลเดอร์ |

## ตัวเลขมาจากไหน

- **% limit และเวลา reset** — มาจาก Anthropic โดยตรง (เป็นค่าเดียวกับใน Claude app
  รวมทุกอุปกรณ์/claude.ai) ถ้ายังไม่ได้ sign in จะอ่านจาก cache ของ Claude desktop app
  แทน และเวลา reset จะติดป้าย **inferred** (เดาจากรูปแบบข้อมูล ปกติแม่นระดับนาที)
- **token / ค่าใช้จ่าย / รายโปรเจกต์** — อ่านจาก transcript ของ Claude Code
  ในเครื่องนี้เท่านั้น ("ค่าใช้จ่าย" คือราคาถ้าจ่ายแบบ API เอาไว้เทียบสัดส่วน ไม่ใช่บิลจริง)

## มีปัญหา / อยากช่วยพัฒนา

เปิด issue ที่ https://github.com/gipsic/claude-usage/issues — ถ้าตัวเลขไม่ตรงกับแอป
แนบภาพหน้า Usage ในแอป + ผล `claude-usage doctor` มาด้วยจะช่วยได้มาก
โค้ดเป็น MIT ยินดีรับ PR ทุกขนาด ดู `CONTRIBUTING.md`
