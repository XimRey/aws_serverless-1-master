const axios = require("axios");
const { encode } = require("html-entities");

const TELEGRAM_TOKEN = "8065002471:AAGonEdez27MYPuNR45rbFHX7YvAah4qqek";
const TELEGRAM_CHAT_ID = "7880005945";

function abreviarNumero(n) {
  n = Number(n);
  if (Math.abs(n) >= 1_000_000) {
    return (n / 1_000_000).toFixed(1) + "M";
  } else if (Math.abs(n) >= 1_000) {
    return (n / 1_000).toFixed(1) + "K";
  }
  return parseInt(n).toString();
}

function limpiarProducto(producto) {
  if (producto.includes(",")) {
    producto = producto.substring(0, producto.lastIndexOf(","));
  }
  return producto.trim();
}

function safePercentage(value, defaultValue = 0) {
  const num = parseFloat(value);
  if (isNaN(num)) return defaultValue;
  return Math.round(num * 100);
}

function topBottomTable(data, contenedor, topN = 5) {
    const subset = data.filter(row => row.contenedor === contenedor);
    if (!subset.length || !('roi' in subset[0])) {
      return `<b>${contenedor.toUpperCase()}</b>\nNo hay datos disponibles.`;
    }
  
    const topItems = [...subset].sort((a, b) => b.roi - a.roi).slice(0, topN);
    const bottomItems = [...subset].sort((a, b) => a.roi - b.roi).slice(0, topN);
  
    const topMsg = topItems.map(row => `
  <b>• ${encode(limpiarProducto(row.producto))}</b>
  <code>🧮 ROI: ${(row.roi * 100).toFixed(1)}%
  📊 Ventas: ${abreviarNumero(row.venta)}
  📦 Cantidad: ${parseInt(row.cantidad_vendida)}
  📤 %Evacuación: ${safePercentage(row.porcentaje_evacuacion)}%</code>`).join("\n");
  
    const bottomMsg = bottomItems.map(row => `
  <b>• ${encode(limpiarProducto(row.producto))}</b>
  <code>🧮 ROI: ${(row.roi * 100).toFixed(1)}%
  📊 Ventas: ${abreviarNumero(row.venta)}
  📦 Cantidad: ${parseInt(row.cantidad_vendida)}
  📤 %Evacuación: ${safePercentage(row.porcentaje_evacuacion)}%</code>`).join("\n");
  
    return `
  <b>📦 Contenedor: ${encode(contenedor.toUpperCase())}</b>
  🔝 Top ${topN} mejores productos por ROI:
  ${topMsg}
  
  🔻 Top ${topN} peores productos por ROI:
  ${bottomMsg}
    `;
  }

async function sendTelegramHTML(text) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) {
    console.error("❌ TELEGRAM_TOKEN o TELEGRAM_CHAT_ID no están definidos");
    return;
  }

  const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
  const payload = {
    chat_id: TELEGRAM_CHAT_ID,
    text,
    parse_mode: "HTML",
  };

  try {
    const response = await axios.post(url, payload);
    console.log("✅ Mensaje enviado por Telegram");
  } catch (error) {
    console.error("❌ Error al enviar mensaje por Telegram:", error.message);
    if (error.response) {
      console.error("🔎 Respuesta del servidor:", error.response.data);
    }
  }
}

// 👇 Ejemplo de uso
/*
const df = [
  { contenedor: "A1", producto: "Producto 1", roi: 0.42, venta: 12300, cantidad_vendida: 120, porcentaje_evacuacion: 0.75 },
  { contenedor: "A1", producto: "Producto 2", roi: 0.12, venta: 3200, cantidad_vendida: 50, porcentaje_evacuacion: 0.30 },
  ...
];

const mensaje = topBottomTable(df, "A1");
sendTelegramHTML(mensaje);
*/

module.exports = {
    topBottomTable,
    sendTelegramHTML,
  };