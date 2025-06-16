'use strict';
require('dotenv').config();
const _ = require('lodash');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { getReportData, getReportDataQ2 } = require('./clikhouseReport.js');
const { topBottomTable, sendTelegramHTML } = require('./messageContenedores.js');
const { ses } = require('../../configurations/awsSetting');
const nodemailer = require('nodemailer');

const sendErrorEmail = async (error) => {
  const transporter = nodemailer.createTransport({
    SES: ses,
  });

  const params = {
    from: 'comunicaciones.sistemas@fastmoda.com.co' ,
    to: ['ximena.rey@fastmoda.com.co'],
    subject: 'Error en el Informe de Contenedores',
    html: `<p>Ha ocurrido un error al ejecutar el informe de Contenedores:</p><p>${error.message}</p>`,
  };

  try {
    const info = await transporter.sendMail(params);
    console.log('Correo de error enviado exitosamente:', info);
  } catch (err) {
    console.error('Error al enviar el correo de error:', err);
  }
};


function generateHtmlTable(data, maxRows = 100) {
  if (!Array.isArray(data) || data.length === 0) {
    return '<p>No hay datos disponibles.</p>';
  }

  const columnsToDisplay = [
    'contenedor', 'producto', 'fecha_ingreso',
    'venta', 'roi', 'cantidad_vendida',
    'porcentaje_evacuacion', 'inventario_actual',
  ].filter(col => col in data[0]);

  let html = `<table class="data-table" style="width:100%; border-collapse:collapse; font-family:Arial,sans-serif; font-size:14px; margin-bottom:20px;">`;

  // Encabezados
  html += '<tr>';
  for (const col of columnsToDisplay) {
    const displayName = col.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
    html += `<th style="background-color:#0D4F8B; color:white; font-weight:bold; text-align:left; padding:8px; border:1px solid #ddd;">${displayName}</th>`;
  }
  html += '</tr>';

  // Filas
  const rowCount = Math.min(data.length, maxRows);
  for (let i = 0; i < rowCount; i++) {
    const row = data[i];
    html += `<tr style="background-color:${i % 2 === 0 ? '#f9f9f9' : 'white'};">`;

    for (const col of columnsToDisplay) {
      const rawValue = row[col];
      let formattedValue = '';
      let style = 'padding:8px; border:1px solid #ddd; text-align:left;';

      // Estilos condicionales
      if (col === 'roi' && typeof rawValue === 'number') {
        if (rawValue < 0) style += ' color:#D32F2F; font-weight:bold;';
        else if (rawValue > 0.5) style += ' color:#388E3C; font-weight:bold;';
        else style += ' color:#FFA000; font-weight:bold;';
      } else if (['porcentaje_evacuacion', 'porcentaje_participacion'].includes(col) && typeof rawValue === 'number') {
        if (rawValue < 0.3) style += ' color:#D32F2F; font-weight:bold;';
        else if (rawValue > 0.7) style += ' color:#388E3C; font-weight:bold;';
        else style += ' color:#FFA000; font-weight:bold;';
      }

      // Formateo de valores
      if (typeof rawValue === 'number') {
        if (['porcentaje_evacuacion', 'porcentaje_participacion', 'roi'].includes(col)) {
          formattedValue = (rawValue * 100).toFixed(1) + '%';
        } else if (['cantidad_vendida', 'inventario_actual', 'venta'].includes(col)) {
          formattedValue = rawValue.toLocaleString('es-CO', { minimumFractionDigits: 0 });
        } else {
          formattedValue = Number.isInteger(rawValue)
            ? rawValue.toLocaleString('es-CO')
            : rawValue.toFixed(2);
        }
      } else if (col === 'fecha_ingreso' && rawValue) {
        const date = new Date(rawValue);
        formattedValue = `${String(date.getDate()).padStart(2, '0')}/${String(date.getMonth() + 1).padStart(2, '0')}/${date.getFullYear()}`;
      } else {
        formattedValue = rawValue ?? '';
      }

      html += `<td style="${style}">${formattedValue}</td>`;
    }

    html += '</tr>';
  }

  html += '</table>';

  if (data.length > maxRows) {
    html += `<p style="font-style:italic; color:#666;">Mostrando ${maxRows} de ${data.length} filas totales.</p>`;
  }
  return html;
}

function promedio(arr) {
  const valid = arr.filter(n => typeof n === 'number');
  return valid.length > 0 ? valid.reduce((a, b) => a + b, 0) / valid.length : 0;
}

async function generateDataAnalysis(df, dfq2) {
  const genAI = new GoogleGenerativeAI('AIzaSyAG7m4Wx2IGG4QKaqIc7EWnBYSW5fA581o');
  const model = genAI.getGenerativeModel({ model: 'gemini-1.5-pro-latest' });

  const totalCompra = dfq2.reduce((acc, row) => acc + (row.compra || 0), 0);
  const totalVenta = dfq2.reduce((acc, row) => acc + (row.venta_contenedor || 0), 0);
  const roiPromedio = totalCompra > 0 ? (totalVenta - totalCompra) / totalCompra : 0;
  const evacuacionPromedio = promedio(dfq2.map(r => r.porcentaje_evacuacion ?? 0));
  const miuPromedio = promedio(dfq2.map(r => r.miu ?? 0));

  const contenedoresBajoROI = [...new Set(df.filter(r => r.roi < 0.2).map(r => r.contenedor))];
  const contenedoresBajaEvacuacion = [...new Set(df.filter(r => r.porcentaje_evacuacion < 0.3).map(r => r.contenedor))];
  const contenedoresAltoMIU = [...new Set(df.filter(r => r.miu > 4).map(r => r.contenedor))];

  const peoresPorContenedor = {};
  const mejoresPorContenedor = {};

  const contenedores = [...new Set(df.map(r => r.contenedor))];

  for (const contenedor of contenedores) {
    const subset = df.filter(r => r.contenedor === contenedor && r.roi !== undefined);
    peoresPorContenedor[contenedor] = subset.sort((a, b) => a.roi - b.roi).slice(0, 5)
      .map(r => `${r.producto} (ROI: ${r.roi.toFixed(2)}, Venta: ${r.venta_contenedor?.toFixed(2)})`);
    mejoresPorContenedor[contenedor] = subset.sort((a, b) => b.roi - a.roi).slice(0, 5)
      .map(r => `${r.producto} (ROI: ${r.roi.toFixed(2)}, Venta: ${r.venta_contenedor?.toFixed(2)})`);
  }

  const detallesCriticos = Object.entries(peoresPorContenedor)
    .map(([contenedor, articulos]) => `- ${contenedor}: ${articulos.join(', ')}`).join('\n');
  const detallesDestacados = Object.entries(mejoresPorContenedor)
    .map(([contenedor, articulos]) => `- ${contenedor}: ${articulos.join(', ')}`).join('\n');

  const prompt = `
    Necesito un análisis detallado para un informe de inventario por contenedor (máximo 3 párrafos) 
    donde sea específico con el detalle de material crítico 5 peores artículos por contenedor, que son:
    ${detallesCriticos}
    y los 5 mejores artículos por contenedor, que son:
    ${detallesDestacados}

    Por favor, proporciona:
    1. Un análisis crítico basado en los artículos con bajo rendimiento por contenedor.
    2. Un análisis de forma detallada por material.

    Usa lenguaje claro y directo. No utilices títulos en negrita ni frases innecesarias.
  `;

  const result = await model.generateContent(prompt);
  const response = await result.response;
  return response.text();
}

function createHtmlReport(df, dfq2, markdownAnalysis, contenedor) {
  const normalize = str => (str || '').toString().trim().toLowerCase();

  const dfContenedor = df.filter(row => normalize(row.contenedor) === normalize(contenedor));
  const dfq2Contenedor = dfq2.filter(row => normalize(row.contenedor) === normalize(contenedor));

  const totalCompra = dfq2Contenedor.reduce((acc, row) => acc + (parseFloat(row.compra) || 0), 0);
  const totalVenta = dfq2Contenedor.length > 0 ? parseFloat(dfq2Contenedor[0].venta_contenedor) || 0 : 0;
  const roiGlobal = totalCompra > 0 ? (totalVenta - totalCompra) / totalCompra : 0;
  const roiGlobalPercent = (roiGlobal * 100).toFixed(2);

  const evacuacionPromedio = dfq2Contenedor.length > 0
    ? dfq2Contenedor.reduce((acc, row) => acc + (parseFloat(row.porcentaje_evacuacion) || 0), 0) / dfq2Contenedor.length
    : 0;

  const miuPromedio = dfq2Contenedor.length > 0
    ? dfq2Contenedor.reduce((acc, row) => acc + (parseFloat(row.miu) || 0), 0) / dfq2Contenedor.length
    : 0;

  const roiClass = roiGlobal > 0.5 ? "positive" : roiGlobal > 0 ? "warning" : "negative";
  const evacuacionClass = evacuacionPromedio > 0.7 ? "positive" : evacuacionPromedio > 0.3 ? "warning" : "negative";
  const miuClass = miuPromedio < 2 ? "positive" : miuPromedio < 4 ? "warning" : "negative";

  let tablasContenedoresHtml = '';
  if (dfContenedor.length > 0) {
    const titulo = `<h3 style='color:#0D4F8B; margin-top:25px;'>Contenedor: ${contenedor}</h3>`;
    const tablaHtml = generateHtmlTable(dfContenedor);
    tablasContenedoresHtml = titulo + tablaHtml;
  }

  const htmlContent = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <title>Informe de ROI e Inventario</title>
      <style>
        body {
          font-family: Arial, sans-serif;
          line-height: 1.3;
          color: #333;
        }
        h1, h2 {
          color: #0D4F8B;
        }
        .kpi-container {
          display: flex;
          gap: 10px;
          margin-bottom: 20px;
        }
        .kpi-box {
          width: 23%;
          min-width: 200px;
          border-radius: 20px;
          background-color: #f5f5f5;
          box-shadow: 0 2px 5px rgba(0,0,0,0.1);
          text-align: center;
          padding: 10px;
        }
        .kpi-title {
          font-size:16px;
          font-weight: bold;
          color: #555;
        }
        .kpi-value {
          font-size: 26px;
          font-weight: bold;
        }
        .positive { color: #388E3C; }
        .warning { color: #FFA000; }
        .negative { color: #D32F2F; }
        .analysis-box {
          background-color: #f9f9f9;
          border-left: 4px solid #0D4F8B;
          padding: 15px;
        }
      </style>
    </head>
    <body>

      <h1>📦 Informe de ROI e Inventario Contenedor ${contenedor}</h1>

      <div class="kpi-container">
        <div class="kpi-box">
          <div class="kpi-title">ROI Global</div>
          <div class="kpi-value ${roiClass}">${roiGlobalPercent}%</div>
        </div>
        <div class="kpi-box">
          <div class="kpi-title">Evacuación</div>
          <div class="kpi-value ${evacuacionClass}">${(evacuacionPromedio * 100).toFixed(1)}%</div>
        </div>
        <div class="kpi-box">
          <div class="kpi-title">MIU Promedio</div>
          <div class="kpi-value ${miuClass}">${miuPromedio.toFixed(1)}</div>
        </div>
        <div class="kpi-box">
          <div class="kpi-title">Compra/Venta</div>
          <div class="kpi-value">$${(totalCompra / 1_000_000).toFixed(1)}M / $${(totalVenta / 1_000_000).toFixed(1)}M</div>
        </div>
      </div>
     <h2>Análisis de Situación</h2>
    <div class="analysis-box">${markdownAnalysis.replace(/\n/g, '<br>')}</div>

      <h2>Datos Detallados por Contenedor</h2>
      ${tablasContenedoresHtml}

    </body>
    </html>
  `;

  return htmlContent;
}


const sendEmail = async (htmlContent, contenedor) => {
  const transporter = nodemailer.createTransport({
    SES: ses,
  });

  const params = {
    from: 'comunicaciones.sistemas@fastmoda.com.co',
    to: [
      'ximena.rey@fastmoda.com.co',

    ],
    subject: `📦 Informe de ROI e Inventario Contenedor ${contenedor?.toUpperCase() || 'DESCONOCIDO'}`,
    html: htmlContent,
  };

  try {
    const info = await transporter.sendMail(params);
    console.log('📬 Correo enviado exitosamente:', info.messageId);
  } catch (error) {
    console.error('❌ Error enviando el correo:', error);
    await sendErrorEmail(error);
    throw error;
  }
};

const main = async () => {
  try {

    // Obtener dataframes
    const result = await getReportData();
    const resultq2 = await getReportDataQ2(result);

    // Normalizar nombres de contenedor
    const normalizeContenedores = (data) =>
      data.map(row => ({
        ...row,
        contenedor: row.contenedor?.trim().toLowerCase() || null,
      }));

    const resultNorm = normalizeContenedores(result);
    const resultq2Norm = normalizeContenedores(resultq2);

    // Obtener lista única de contenedores no nulos
    const contenedoresUnicos = _.uniq(
      resultNorm.map(r => r.contenedor).filter(Boolean)
    );

    for (const contenedor of contenedoresUnicos) {
      const contenedorFiltrado = contenedor.trim().toLowerCase();

      const dfContenedor = resultNorm.filter(r => r.contenedor === contenedorFiltrado);
      const dfq2Contenedor = resultq2Norm.filter(r => r.contenedor === contenedorFiltrado);

      if (dfq2Contenedor.length === 0) {
        console.warn(`⚠️  No se encontraron datos en resultq2 para el contenedor '${contenedor}'`);
      }

      const analysisMd = await generateDataAnalysis(dfContenedor, dfq2Contenedor);
      const htmlReport = await createHtmlReport(dfContenedor, dfq2Contenedor, analysisMd, contenedor);
      await sendEmail(htmlReport, contenedor);

      // Opcional: enviar a Telegram
      const htmlSummary = topBottomTable(dfContenedor, contenedorFiltrado, 5);
      await sendTelegramHTML(htmlSummary);
    }

    console.log('✅ Todos los reportes fueron procesados.');
  } catch (err) {
    console.error('❌ Error general:', err);
  }
};

main();


