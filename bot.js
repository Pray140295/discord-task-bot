require("dotenv").config();

const {
  Client,
  GatewayIntentBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder
} = require("discord.js");

const express = require("express");
const axios = require("axios");

const app = express();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds
  ]
});

// ======================================================
// CONFIG
// ======================================================

const GOOGLE_SCRIPT_URL = process.env.GOOGLE_SCRIPT_URL;
const MANAGER_ROLE_ID   = process.env.MANAGER_ROLE_ID;
const CHANNEL_TASK_NEW  = process.env.CHANNEL_TASK_NEW;
const CHANNEL_REVIEW    = process.env.CHANNEL_REVIEW;
const CHANNEL_DONE      = process.env.CHANNEL_DONE;

// ======================================================
// KEEP ALIVE
// ======================================================

app.get("/", (req, res) => {
  res.send("Bot Online");
});

app.get("/ping", (req, res) => {
  res.send("pong");
});

app.listen(process.env.PORT || 3000, () => {
  console.log("Web Server Running");
});

// ======================================================
// READY
// ======================================================

client.once("ready", () => {
  console.log(`Logged in as ${client.user.tag}`); startPolling(); // Bắt đầu quét an toàn chống spam });  // ====================================================== // HELPERS // ======================================================  async function apiGet(action) { const url = `${GOOGLE_SCRIPT_URL}?action=${action}`; const res = await axios.get(url, { timeout: 30000 }); // Đặt timeout 30s return res.data; }  async function apiPost(data) { const res = await axios.post(GOOGLE_SCRIPT_URL, data, { timeout: 30000 }); return res.data; }  function createTaskEmbed(task) { return new EmbedBuilder() .setTitle("📋 TASK MỚI") .addFields( { name: "Request ID",     value: String(task.requestId \vert{}\vert{} "-") }, { name: "Người gửi",      value: String(task.sender \vert{}\vert{} "-") }, { name: "Team",           value: String(task.team \vert{}\vert{} "-") }, { name: "Thương hiệu",    value: String(task.brand \vert{}\vert{} "-") }, { name: "Phân loại",      value: String(task.category \vert{}\vert{} "-") }, { name: "Deadline",       value: String(task.deadline \vert{}\vert{} "-") }, { name: "Độ gấp",         value: String(task.priority \vert{}\vert{} "-") }, { name: "Kích thước",     value: String(task.format \vert{}\vert{} "-") }, { name: "Số lượng",       value: String(task.quantity \vert{}\vert{} "-") }, { name: "Brief",          value: String(task.brief \vert{}\vert{} "-").substring(0, 1000) }, { name: "File tham khảo", value: task.fileRef ? `[Mở File](${task.fileRef})` : "-" },
      { name: "Trạng thái",     value: String(task.status || "-") }
    )
    .setColor("#5865F2");
}

function createAssignButtons() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("assign_HUYNH")
      .setLabel("HUYNH")
      .setStyle(ButtonStyle.Primary),

    new ButtonBuilder()
      .setCustomId("assign_NANCY")
      .setLabel("NANCY")
      .setStyle(ButtonStyle.Success),

    new ButtonBuilder()
      .setCustomId("assign_NGỌC")
      .setLabel("NGỌC")
      .setStyle(ButtonStyle.Secondary)
  );
}

function createStatusButtons(requestId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`status_In Progress_${requestId}`)
      .setLabel("Đang Làm")
      .setStyle(ButtonStyle.Primary),

    new ButtonBuilder()
      .setCustomId(`status_Review_${requestId}`) .setLabel("Chờ Review") .setStyle(ButtonStyle.Success),  new ButtonBuilder() .setCustomId(`status_Done_${requestId}`)
      .setLabel("Done")
      .setStyle(ButtonStyle.Danger)
  );
}

// ======================================================
// MONITOR TASKS (CHỐNG SPAM & KHÓA LUỒNG TUYỆT ĐỐI)
// ======================================================

let isPolling = false;
// Bộ nhớ RAM tạm thời lưu các task đang/đã gửi để chống spam tuyệt đối
const processingTaskIds = new Set();

async function pollUnsyncedTasks() {
  if (isPolling) return; // Nếu lượt trước chưa xong thì bỏ qua ngay
  isPolling = true;

  try {
    const tasks = await apiGet("unsynced");

    if (!Array.isArray(tasks)) {
      console.log("⚠️ API không trả về mảng:", tasks);
      return;
    }

    if (!tasks.length) {
      return;
    }

    const channel = await client.channels.fetch(CHANNEL_TASK_NEW);

    for (const task of tasks) {
      const reqId = String(task.requestId || "").trim();
      if (!reqId) continue;

      // 🛑 CHỐT CHẶN 1: Nếu task này đang được gửi hoặc vừa gửi trong phiên này -> BỎ QUA
      if (processingTaskIds.has(reqId)) {
        console.log(`⏳ Bỏ qua task ${reqId} vì đang xử lý hoặc đã gửi.`);
        continue;
      }

      // Đánh dấu ngay vào RAM là task đang được xử lý
      processingTaskIds.add(reqId);

      try {
        console.log("📤 Đang gửi task lên Discord:", reqId);

        // 1. Gửi tin nhắn lên kênh Discord
        const msg = await channel.send({
          embeds: [createTaskEmbed(task)],
          components: [createAssignButtons()]
        });

        // 2. Báo lại cho Google Sheet để đóng dấu SYNCED
        const saveRes = await apiPost({
          action: "discordInfo",
          requestId: reqId,
          messageId: msg.id,
          channelId: channel.id,
          messageUrl: msg.url
        });

        console.log(`✅ Task ${reqId} đã sync thành công về Sheet:`, saveRes);

        // Giữ task trong danh sách khóa thêm 30 giây để đảm bảo Sheet kịp flush dữ liệu
        setTimeout(() => {
          processingTaskIds.delete(reqId);
        }, 30000);

      } catch (sendErr) {
        console.error(`❌ Lỗi khi gửi task ${reqId}:`, sendErr);
        // Nếu gửi thất bại, giải phóng khóa sau 15 giây để thử lại sau
        setTimeout(() => {
          processingTaskIds.delete(reqId);
        }, 15000);
      }
    }

  } catch (err) {
    console.error("❌ MONITOR ERROR:", err.message);
  } finally {
    isPolling = false; // Mở khóa cho lượt quét tiếp theo
  }
}

// Chạy vòng lặp an toàn: lượt trước xong xuôi mới hẹn giờ chạy lượt tiếp theo
function startPolling() {
  console.log("========== SAFE MONITOR STARTED ==========");
  
  const runLoop = async () => {
    await pollUnsyncedTasks();
    setTimeout(runLoop, 15000); // Đợi đủ 15s sau khi hoàn thành rồi mới quét tiếp
  };

  runLoop();
}

// ======================================================
// INTERACTION (BUTTON CLICK)
// ======================================================

client.on("interactionCreate", async interaction => {
  if (!interaction.isButton()) return;

  try {
    const customId = interaction.customId;

    // ==================================================
    // ASSIGN BUTTON
    // ==================================================
    if (customId.startsWith("assign_")) {
      const member = interaction.member;

      if (!member.roles.cache.has(MANAGER_ROLE_ID)) {
        return interaction.reply({
          content: "❌ Bạn không có quyền assign task.",
          ephemeral: true
        });
      }

      const designer = customId.replace("assign_", "");
      const embed = interaction.message.embeds[0];
      const requestId = embed.fields[0].value;

      console.log("ASSIGN REQUEST:", { requestId, designer });

      await interaction.deferUpdate(); // Báo cho Discord biết bot đang xử lý để tránh lỗi nút bấm bị timeout

      const result = await apiPost({
        action: "assign",
        requestId,
        designer
      });

      console.log("Assign Result:", result);

      const task = await apiPost({
        action: "task",
        requestId
      });

      const designerChannelMap = {
        "HUYNH": "1511559274625765480",
        "NANCY": "1511559338043641916",
        "NGỌC":  "1511559317298352288"
      };

      const targetChannelId = designerChannelMap[designer];
      if (targetChannelId) {
        const targetChannel = await client.channels.fetch(targetChannelId);
        await targetChannel.send({
          content: `🎨 Task mới cho ${designer}`,
          embeds: [createTaskEmbed(task)],
          components: [createStatusButtons(requestId)]
        });
      }

      await interaction.editReply({
        content: `✅ Đã assign cho ${designer}`,
        components: []
      });

      return;
    }

    // ==================================================
    // STATUS BUTTON
    // ==================================================
    if (customId.startsWith("status_")) {
      const parts = customId.split("_");
      const status = parts[1];
      const requestId = parts[2];

      await apiPost({
        action: "status",
        requestId,
        status
      });

      if (status === "Review") {
        const reviewChannel = await client.channels.fetch(CHANNEL_REVIEW);
        await reviewChannel.send({
          content: `👀 Task cần
