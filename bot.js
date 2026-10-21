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
const MANAGER_ROLE_ID = process.env.MANAGER_ROLE_ID;
const CHANNEL_TASK_NEW = process.env.CHANNEL_TASK_NEW;
const CHANNEL_REVIEW = process.env.CHANNEL_REVIEW;
const CHANNEL_DONE = process.env.CHANNEL_DONE;

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

function createTaskEmbed(task) {
  return new EmbedBuilder()
    .setTitle("📋 TASK MỚI")
    .addFields(
      { name: "Request ID", value: String(task.requestId || "-") },
      { name: "Người gửi", value: String(task.sender || "-") },
      { name: "Team", value: String(task.team || "-") },
      { name: "Thương hiệu", value: String(task.brand || "-") },
      { name: "Phân loại", value: String(task.category || "-") },
      { name: "Deadline", value: String(task.deadline || "-") },
      { name: "Độ gấp", value: String(task.priority || "-") },
      { name: "Kích thước", value: String(task.format || "-") },
      { name: "Số lượng", value: String(task.quantity || "-") },
      { name: "Brief", value: String(task.brief || "-").substring(0, 1000) },
      { name: "File tham khảo", value: task.fileRef ? `[Mở File](${task.fileRef})` : "-" },
      { name: "Trạng thái", value: String(task.status || "-") }
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

    if (!Array.isArray(tasks)) {
      console.log("⚠️ API không trả về mảng:", tasks);
      return;
    }

    if (!tasks.length) return;

    const channel = await client.channels.fetch(CHANNEL_TASK_NEW);

    for (const task of tasks) {
      const reqId = String(task.requestId || "").trim();
      if (!reqId) continue;

      if (processingTaskIds.has(reqId)) {
        console.log(`⏳ Bỏ qua task ${reqId} vì đang xử lý.`);
        continue;
      }

      processingTaskIds.add(reqId);

      try {
        console.log("📤 Đang gửi task lên Discord:", reqId);

        const msg = await channel.send({
          embeds: [createTaskEmbed(task)],
          components: [createAssignButtons()]
        });

        const saveRes = await apiPost({
          action: "discordInfo",
          requestId: reqId,
          messageId: msg.id,
          channelId: channel.id,
          messageUrl: msg.url
        });

        console.log(`✅ Task ${reqId} đã sync:`, saveRes);

        setTimeout(() => {
          processingTaskIds.delete(reqId);
        }, 30000);

      } catch (sendErr) {
        console.error(`❌ Lỗi gửi task ${reqId}:`, sendErr);
        setTimeout(() => {
          processingTaskIds.delete(reqId);
        }, 15000);
      }
    }
  } catch (err) {
    console.error("❌ MONITOR ERROR:", err.message);
  } finally {
    isPolling = false;
  }
}

function startPolling() {
  console.log("========== SAFE MONITOR STARTED ==========");
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

    // ==================================================
    // ASSIGN
    // ==================================================
    if (customId.startsWith("assign_")) {
      const member = interaction.member;

      // 1. Xác thực quyền Quản trị
      if (!member.roles.cache.has(MANAGER_ROLE_ID)) {
        return interaction.reply({
          content: "❌ Bạn không có quyền assign task.",
          ephemeral: true
        });
      }

      // 2. Phản hồi Discord lập tức để tránh lỗi hết hạn tương tác (3 giây)
      await interaction.deferUpdate().catch(() => {});

      // Chuẩn hóa tên Designer khử lỗi bảng mã tiếng Việt Unicode
      const designerRaw = customId.replace("assign_", "");
      const designer = String(designerRaw).trim().normalize("NFC");

      const embed = interaction.message.embeds[0];
      const requestId = embed.fields[0].value;

      console.log("ASSIGN REQUEST:", { requestId, designer });

      // 3. Ghi nhận Designer lên Google Sheet
      const result = await apiPost({
        action: "assign",
        requestId,
        designer
      });

      console.log("Assign Result:", result);

      // 4. Cập nhật nút bấm thành trạng thái đã giao việc
      await interaction.editReply({
        content: `✅ Đã assign cho **${designer}**`,
        components: []
      }).catch(console.error);

      // 5. Luồng gửi thông báo vào kênh cá nhân Designer (bọc riêng để tránh treo bot)
      try {
        const designerChannelMap = {
          "HUYNH": "1511559274625765480",
          "NANCY": "1511559338043641916",
          "NGỌC": "1511559317298352288"
        };

        const targetChannelId = designerChannelMap[designer] || designerChannelMap[designer.toUpperCase()];

        if (targetChannelId) {
          const task = await apiPost({
            action: "task",
            requestId
          });

          const targetChannel = await client.channels.fetch(targetChannelId);
          if (targetChannel) {
            await targetChannel.send({
              content: `🎨 Task mới cho ${designer}`,
              embeds: [createTaskEmbed(task)],
              components: [createStatusButtons(requestId)]
            });
          }
        } else {
          console.log(`⚠️ Không tìm thấy channel map cho Designer: ${designer}`);
        }
      } catch (notifyErr) {
        console.error("⚠️ Lỗi gửi tin sang kênh riêng Designer:", notifyErr.message);
      }

      return;
    }

    // ==================================================
    // STATUS
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
        try {
          const reviewChannel = await client.channels.fetch(CHANNEL_REVIEW);
          if (reviewChannel) {
            await reviewChannel.send({
              content: `👀 Task cần review: ${requestId}`
            });
          }
        } catch (e) {
          console.error("Lỗi gửi kênh Review:", e.message);
        }
      }

      if (status === "Done") {
        try {
          const doneChannel = await client.channels.fetch(CHANNEL_DONE);
          if (doneChannel) {
            await doneChannel.send({
              content: `✅ Task hoàn thành: ${requestId}`
            });
          }
        } catch (e) {
          console.error("Lỗi gửi kênh Done:", e.message);
        }
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
// LOGIN
// ======================================================

client.login(process.env.DISCORD_TOKEN);
