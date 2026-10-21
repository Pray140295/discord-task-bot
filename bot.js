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
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

// ======================================================
// CONFIG MÔI TRƯỜNG
// ======================================================

const GOOGLE_SCRIPT_URL = process.env.GOOGLE_SCRIPT_URL;
const MANAGER_ROLE_ID   = process.env.MANAGER_ROLE_ID;
const CHANNEL_TASK_NEW  = process.env.CHANNEL_TASK_NEW;
const CHANNEL_REVIEW    = process.env.CHANNEL_REVIEW;
const CHANNEL_DONE      = process.env.CHANNEL_DONE;

// ======================================================
// KEEP ALIVE WEB SERVER (CHO RENDER / UPTIME KUMA)
// ======================================================

app.get("/", (req, res) => res.send("Bot Online"));
app.get("/ping", (req, res) => res.send("pong"));

app.listen(process.env.PORT || 3000, () => {
  console.log("Web Server Running");
});

// ======================================================
// READY & KHỞI ĐỘNG HỆ THỐNG
// ======================================================

client.once("ready", async () => {
  console.log(`Logged in as ${client.user.tag}`);

  // Tự động quét và dọn sạch các tin nhắn task trùng lặp lúc khởi động
  await cleanupDuplicateTaskMessages();

  // Khởi chạy vòng lặp kiểm tra task mới an toàn
  startPolling();
});

// ======================================================
// API HELPERS
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

// ======================================================
// ĐỒNG BỘ DESIGNER & CHANNEL ID ĐỘNG TỪ SHEET SETTINGS
// ======================================================

let cachedDesigners = [];
let lastFetchTime = 0;

async function getDynamicDesigners() {
  const now = Date.now();
  // Giữ cache trong 2 phút (120000ms) để tối ưu tốc độ và không spam Sheet
  if (cachedDesigners.length > 0 && (now - lastFetchTime) < 120000) {
    return cachedDesigners;
  }
  try {
    const list = await apiGet("designers");
    if (Array.isArray(list) && list.length > 0) {
      cachedDesigners = list;
      lastFetchTime = now;
      console.log("🔄 Đã đồng bộ danh sách Designer từ SETTINGS:", list.map(d => d.name));
    }
  } catch (err) {
    console.error("Lỗi lấy danh sách designers từ Sheet:", err.message);
  }
  return cachedDesigners;
}

// ======================================================
// EMBED & BUTTON BUILDERS
// ======================================================

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

async function createAssignButtonsDynamic() {
  const designers = await getDynamicDesigners();
  const rows = [];
  let currentRow = new ActionRowBuilder();

  const styles = [ButtonStyle.Primary, ButtonStyle.Success, ButtonStyle.Secondary];

  designers.forEach((d, idx) => {
    // Discord giới hạn tối đa 5 nút trên 1 hàng (Row)
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
// QUÉT VÀ DỌN DẸP TIN NHẮN TRÙNG LẶP TRONG KÊNH TASK MỚI
// ======================================================

async function cleanupDuplicateTaskMessages() {
  try {
    const channel = await client.channels.fetch(CHANNEL_TASK_NEW);
    if (!channel) return;

    console.log("🧹 Bắt đầu quét tin nhắn trùng lặp trong kênh Task mới...");
    const messages = await channel.messages.fetch({ limit: 100 });

    const seenTaskIds = new Set();
    const messagesToDelete = [];

    messages.forEach((msg) => {
      if (msg.author.id === client.user.id && msg.embeds.length > 0) {
        const embed = msg.embeds[0];
        const reqIdField = embed.fields.find(f => f.name === "Request ID");
        if (reqIdField && reqIdField.value && reqIdField.value !== "-") {
          const reqId = reqIdField.value.trim();

          if (seenTaskIds.has(reqId)) {
            messagesToDelete.push(msg);
          } else {
            seenTaskIds.add(reqId);
          }
        }
      }
    });

    console.log(`🧹 Tìm thấy ${messagesToDelete.length} tin nhắn trùng lặp.`);

    for (const msg of messagesToDelete) {
      await msg.delete().catch(() => {});
      await new Promise(r => setTimeout(r, 1000)); // Tránh giới hạn tốc độ của Discord
    }

    console.log("✅ Dọn dẹp tin nhắn trùng lặp hoàn tất!");
  } catch (err) {
    console.error("❌ Lỗi dọn dẹp tin nhắn:", err.message);
  }
}

// ======================================================
// SAFE POLLING (CHỐNG SPAM & KHÓA LUỒNG TUYỆT ĐỐI)
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

        console.log(`✅ Task ${reqId} đã sync thành công:`, msg.id);

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
// XỬ LÝ LỆNH CHAT VÀ NÚT BẤM (INTERACTIONS)
// ======================================================

// 1. Lệnh chat thủ công xóa tin trùng: !cleandup
client.on("messageCreate", async (message) => {
  if (message.author.bot || message.content !== "!cleandup") return;

  if (!message.member.roles.cache.has(MANAGER_ROLE_ID)) {
    return message.reply("❌ Bạn không có quyền sử dụng lệnh này.");
  }

  const statusMsg = await message.reply("⏳ Đang quét và dọn dẹp tin nhắn trùng lặp...");
  await cleanupDuplicateTaskMessages();
  await statusMsg.edit("✅ Đã dọn dẹp xong toàn bộ tin nhắn trùng lặp trong kênh!");
});

// 2. Sự kiện nhấn nút
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isButton()) return;

  try {
    const customId = interaction.customId;

    // --- NÚT GÁN DESIGNER ---
    if (customId.startsWith("assign_")) {
      const member = interaction.member;

      // Phản hồi Discord tức thì để tránh timeout 3s
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

      // Gửi thông báo đến kênh cá nhân Designer
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
          console.log(`⚠️ Designer ${designer} chưa có Channel ID tại sheet SETTINGS.`);
        }
      } catch (notifyErr) {
        console.error("⚠️ Lỗi gửi tin sang kênh Designer:", notifyErr.message);
      }

      return;
    }

    // --- NÚT CẬP NHẬT TRẠNG THÁI ---
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
// LOGIN DISCORD CLIENT
// ======================================================

client.login(process.env.DISCORD_TOKEN);
