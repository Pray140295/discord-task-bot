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
  intents: [GatewayIntentBits.Guilds]
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

app.get("/", (req, res) => res.send("Bot Online"));
app.get("/ping", (req, res) => res.send("pong"));

app.listen(process.env.PORT || 3000, () => {
  console.log("Web Server Running");
});

// ======================================================
// READY
// ======================================================

client.once("ready", () => {
  console.log(`Logged in as ${client.user.tag}`);
  startPolling();
});

// ======================================================
// HELPERS
// ======================================================

async function apiGet(action) {
  const url = `${GOOGLE_SCRIPT_URL}?action=${action}`;
  const res = await axios.get(url, { timeout: 30000 });
  return res.data;
}

async function apiPost(data) {
  const res = await axios.post(GOOGLE_SCRIPT_URL, data, { timeout: 30000 });
  return res.data;
}

// 🌟 HÀM LẤY DANH SÁCH DESIGNER ĐỘNG TỪ SHEET SETTINGS (CACHE 2 PHÚT)
let cachedDesigners = [];
let lastFetchTime = 0;

async function getDynamicDesigners() {
  const now = Date.now();
  if (cachedDesigners.length > 0 && (now - lastFetchTime) < 120000) {
    return cachedDesigners;
  }
  try {
    const list = await apiGet("designers");
    if (Array.isArray(list) && list.length > 0) {
      cachedDesigners = list;
      lastFetchTime = now;
      console.log("🔄 Đã đồng bộ danh sách Designer mới từ SETTINGS:", list.map(d => d.name));
    }
  } catch (err) {
    console.error("Lỗi lấy danh sách designers từ Sheet:", err.message);
  }
  return cachedDesigners;
}

function createTaskEmbed(task) {
  return new EmbedBuilder()
    .setTitle("📋 TASK MỚI")
    .addFields(
      { name: "Request ID",     value: String(task.requestId || "-") },
      { name: "Người gửi",      value: String(task.sender || "-") },
      { name: "Team",           value: String(task.team || "-") },
      { name: "Thương hiệu",    value: String(task.brand || "-") },
      { name: "Phân loại",      value: String(task.category || "-") },
      { name: "Deadline",       value: String(task.deadline || "-") },
      { name: "Độ gấp",         value: String(task.priority || "-") },
      { name: "Kích thước",     value: String(task.format || "-") },
      { name: "Số lượng",       value: String(task.quantity || "-") },
      { name: "Brief",          value: String(task.brief || "-").substring(0, 1000) },
      { name: "File tham khảo", value: task.fileRef ? `[Mở File](${task.fileRef})` : "-" },
      { name: "Trạng thái",     value: String(task.status || "-") }
    )
    .setColor("#5865F2");
}

// 🌟 TỰ ĐỘNG SINH NÚT BẤM DỰA TRÊN DANH SÁCH TỪ SHEET SETTINGS
async function createAssignButtonsDynamic() {
  const designers = await getDynamicDesigners();
  const rows = [];
  let currentRow = new ActionRowBuilder();

  // Danh sách màu nút luân phiên cho đẹp mắt
  const styles = [ButtonStyle.Primary, ButtonStyle.Success, ButtonStyle.Secondary];

  designers.forEach((d, idx) => {
    // Discord giới hạn 5 nút trên 1 hàng (Row)
    if (currentRow.components.length >= 5) {
      rows.push(currentRow);
      currentRow = new ActionRowBuilder();
    }

    currentRow.addComponents(
      new ButtonBuilder()
        .setCustomId(`assign_${d.name}`)
        .setLabel(d.name)
        .setStyle(styles[idx % styles.length])
    );
  });

  if (currentRow.components.length > 0) {
    rows.push(currentRow);
  }

  return rows;
}

function createStatusButtons(requestId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`status_In Progress_${requestId}`)
      .setLabel("Đang Làm")
      .setStyle(ButtonStyle.Primary),

    new ButtonBuilder()
      .setCustomId(`status_Review_${requestId}`)
      .setLabel("Chờ Review")
      .setStyle(ButtonStyle.Success),

    new ButtonBuilder()
      .setCustomId(`status_Done_${requestId}`)
      .setLabel("Done")
      .setStyle(ButtonStyle.Danger)
  );
}

// ======================================================
// MONITOR TASKS
// ======================================================

let isPolling = false;
const processingTaskIds = new Set();

async function pollUnsyncedTasks() {
  if (isPolling) return;
  isPolling = true;

  try {
    const tasks = await apiGet("unsynced");
    if (!Array.isArray(tasks) || !tasks.length) return;

    const channel = await client.channels.fetch(CHANNEL_TASK_NEW);

    for (const task of tasks) {
      const reqId = String(task.requestId || "").trim();
      if (!reqId || processingTaskIds.has(reqId)) continue;

      processingTaskIds.add(reqId);

      try {
        console.log("📤 Đang gửi task lên Discord:", reqId);

        // Sinh nút bấm Designer hoàn toàn tự động từ SETTINGS
        const assignRows = await createAssignButtonsDynamic();

        const msg = await channel.send({
          embeds: [createTaskEmbed(task)],
          components: assignRows
        });

        await apiPost({
          action: "discordInfo",
          requestId: reqId,
          messageId: msg.id,
          channelId: channel.id,
          messageUrl: msg.url
        });

        console.log(`✅ Task ${reqId} đã sync:`, msg.id);

        setTimeout(() => processingTaskIds.delete(reqId), 30000);
      } catch (sendErr) {
        console.error(`❌ Lỗi gửi task ${reqId}:`, sendErr.message);
        setTimeout(() => processingTaskIds.delete(reqId), 15000);
      }
    }
  } catch (err) {
    console.error("❌ MONITOR ERROR:", err.message);
  } finally {
    isPolling = false;
  }
}

function startPolling() {
  console.log("========== SAFE DYNAMIC MONITOR STARTED ==========");
  const runLoop = async () => {
    await pollUnsyncedTasks();
    setTimeout(runLoop, 15000);
  };
  runLoop();
}

// ======================================================
// INTERACTION
// ======================================================

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isButton()) return;

  try {
    const customId = interaction.customId;

    if (customId.startsWith("assign_")) {
      const member = interaction.member;

      await interaction.deferUpdate().catch(() => {});

      if (!member.roles.cache.has(MANAGER_ROLE_ID)) {
        return interaction.followUp({
          content: "❌ Bạn không có quyền assign task.",
          ephemeral: true
        });
      }

      const designer = customId.replace("assign_", "").trim().normalize("NFC");
      const embed = interaction.message.embeds[0];
      const requestId = embed.fields[0].value;

      console.log("ASSIGN REQUEST:", { requestId, designer });

      await apiPost({
        action: "assign",
        requestId,
        designer
      });

      await interaction.editReply({
        content: `✅ Đã assign cho **${designer}**`,
        components: []
      }).catch(console.error);

      // 🌟 TÌM KÊNH CỦA DESIGNER ĐỘNG TỪ BẢNG SETTINGS
      try {
        const currentDesigners = await getDynamicDesigners();
        const found = currentDesigners.find(d => d.name.toUpperCase() === designer.toUpperCase());

        if (found && found.channelId) {
          const task = await apiPost({ action: "task", requestId });
          const targetChannel = await client.channels.fetch(found.channelId);
          if (targetChannel) {
            await targetChannel.send({
              content: `🎨 Task mới cho ${designer}`,
              embeds: [createTaskEmbed(task)],
              components: [createStatusButtons(requestId)]
            });
          }
        } else {
          console.log(`⚠️ Designer ${designer} chưa được cấu hình Channel ID tại Sheet SETTINGS.`);
        }
      } catch (notifyErr) {
        console.error("⚠️ Lỗi gửi tin sang kênh Designer:", notifyErr.message);
      }

      return;
    }

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
        try {
          const reviewChannel = await client.channels.fetch(CHANNEL_REVIEW);
          if (reviewChannel) {
            await reviewChannel.send({ content: `👀 Task cần review: ${requestId}` });
          }
        } catch (e) {}
      }

      if (status === "Done") {
        try {
          const doneChannel = await client.channels.fetch(CHANNEL_DONE);
          if (doneChannel) {
            await doneChannel.send({ content: `✅ Task hoàn thành: ${requestId}` });
          }
        } catch (e) {}
      }

      await interaction.reply({
        content: `✅ Đã cập nhật: ${status}`,
        ephemeral: true
      });

      return;
    }
  } catch (err) {
    console.error("INTERACTION ERROR:", err);
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.followUp({ content: "❌ Có lỗi xảy ra.", ephemeral: true });
      } else {
        await interaction.reply({ content: "❌ Có lỗi xảy ra.", ephemeral: true });
      }
    } catch (e) {}
  }
});

// ======================================================
// HÀM DỌN DẸP TIN NHẮN TRÙNG LẶP TRONG KÊNH TASK MỚI
// ======================================================
async function cleanupDuplicateTaskMessages() {
  try {
    const channel = await client.channels.fetch(CHANNEL_TASK_NEW);
    if (!channel) return;

    console.log("🧹 Bắt đầu quét tin nhắn trùng lặp...");
    // Lấy 100 tin nhắn gần nhất trong kênh
    const messages = await channel.messages.fetch({ limit: 100 });

    const seenTaskIds = new Set();
    const messagesToDelete = [];

    // Duyệt qua từng tin nhắn từ mới nhất đến cũ hơn
    messages.forEach((msg) => {
      // Chỉ kiểm tra tin nhắn do chính bot gửi và có embed
      if (msg.author.id === client.user.id && msg.embeds.length > 0) {
        const embed = msg.embeds[0];
        // Tìm trường Request ID trong Embed
        const reqIdField = embed.fields.find(f => f.name === "Request ID");
        if (reqIdField && reqIdField.value && reqIdField.value !== "-") {
          const reqId = reqIdField.value.trim();

          if (seenTaskIds.has(reqId)) {
            // Đã thấy task này trước đó -> Đánh dấu tin này là trùng lặp để xóa
            messagesToDelete.push(msg);
          } else {
            // Lần đầu thấy task này -> Giữ lại
            seenTaskIds.add(reqId);
          }
        }
      }
    });

    console.log(`🧹 Tìm thấy ${messagesToDelete.length} tin nhắn trùng lặp cần xóa.`);

    // Thực hiện xóa các tin nhắn trùng lặp
    for (const msg of messagesToDelete) {
      await msg.delete().catch(() => {});
      // Nghỉ 1 giây giữa các lần xóa để tránh bị Discord rate-limit
      await new Promise(r => setTimeout(r, 1000));
    }

    console.log("✅ Đã dọn dẹp xong tin nhắn trùng lặp!");
  } catch (err) {
    console.error("❌ Lỗi dọn dẹp tin nhắn:", err.message);
  }
}

// ======================================================
// LOGIN
// ======================================================

client.login(process.env.DISCORD_TOKEN);
