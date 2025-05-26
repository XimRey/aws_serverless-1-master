'use strict';
const { athena, ses } = require('../configurations/awsSetting');
const nodemailer = require('nodemailer');
const { format, subDays, startOfMonth, addMonths, subYears, getDate, subMonths } = require('date-fns');
const { es } = require('date-fns/locale');

// Función para enviar correos electrónicos de error a Cristian
const sendErrorEmail = async (error) => {
  const transporter = nodemailer.createTransport({
    SES: ses,
  });

  const params = {
    from: 'comunicaciones.sistemas@fastmoda.com.co 🇭🇳 Venta_Lili_Honduras',
    to: ['comunicaciones.sistemas@fastmoda.com.co'],
    subject: 'Error en el Informe de Ventas Honduras',
    html: `<p>Ha ocurrido un error al ejecutar el informe de ventas Honduras:</p><p>${error.message}</p>`,
  };

  try {
    const info = await transporter.sendMail(params);
    console.log('Correo de error enviado exitosamente:', info);
  } catch (err) {
    console.error('Error al enviar el correo de error:', err);
  }
};

// Función para ejecutar consultas SQL en Athena
const executeSQLMethod = async (query) => {
  const params = {
    QueryString: query,
    QueryExecutionContext: {
      Database: 'cegid-sql-server-analytics'
    },
    ResultConfiguration: {
      OutputLocation: 's3://lilipink-0000-base-poctst-00-analytics/emailsoutputs/'
    }
  };

  try {
    const data = await athena.startQueryExecution(params).promise();
    const queryExecutionId = data.QueryExecutionId;

    // Espera hasta que la consulta se complete
    let queryStatus = 'QUEUED';
    while (queryStatus === 'QUEUED' || queryStatus === 'RUNNING') {
      const queryExecution = await athena.getQueryExecution({ QueryExecutionId: queryExecutionId }).promise();
      queryStatus = queryExecution.QueryExecution.Status.State;
      if (queryStatus === 'FAILED' || queryStatus === 'CANCELLED') {
        throw new Error(`La ejecución de la consulta falló o fue cancelada: ${queryExecutionId}`);
      }
      await new Promise(resolve => setTimeout(resolve, 1000)); // Espera 1 segundo antes de verificar nuevamente
    }

    // Una vez que la consulta está completa, obtiene los resultados
    const queryResults = await athena.getQueryResults({ QueryExecutionId: queryExecutionId }).promise();
    const columns = queryResults.ResultSet.ResultSetMetadata.ColumnInfo.map(column => column.Name);
    const rows = queryResults.ResultSet.Rows.slice(1); // Ignorar la primera fila que contiene los nombres de las columnas
    const results = rows.map(row => {
      const result = {};
      row.Data.forEach((value, index) => {
        result[columns[index]] = value.VarCharValue;
      });
      return result;
    });

    return results;
  } catch (error) {
    console.error('Error al ejecutar la consulta SQL:', error);
    throw error;
  }
};

// Función para obtener la tasa de conversión USD a HNL
const getConversionRate = async () => {
  try {
    const response = await fetch('https://open.er-api.com/v6/latest/USD');
    if (!response.ok) {
      throw new Error(`Error HTTP! estado: ${response.status}`);
    }
    const data = await response.json();
    const rates = data.rates;
    const hnToUsdRate = rates['HNL'];
    if (!hnToUsdRate) {
      throw new Error('No se pudo obtener la tasa de conversión HNL a USD.');
    }
    return hnToUsdRate;
  } catch (error) {
    console.error('Error al obtener la tasa de conversión:', error);
    throw error;
  }
};

// Función para ejecutar la consulta SQL con fechas
const executeSQLQuery = async (startDate, endDate) => {
  const ini_month_past_year = subYears(startDate, 1);
  const fin_month_past_year = format(subYears(endDate, 1), 'yyyy-MM-dd');

  const query = `
      SELECT
          REGEXP_REPLACE(rb.name, '(\w)(\w*)', x -> upper(x[1]) || lower(x[2])) AS "store",
          FORMAT('%,.2f', ROUND(SUM(pol.price_subtotal), 2)) AS "sales",
          CAST(SUM(CASE
            WHEN pc.name LIKE '%B-REGALO / SUMINISTROS%'
                OR pc.name LIKE 'BOLSA'
                OR pc.name LIKE '%CUPON%'
                OR pc.name LIKE '%GIFTCARDS%'
                OR pc.name LIKE '%GIFTCARDS INVENTARIADOS%'
                OR pc.name LIKE '%PROMOCIONES%'
            THEN 0 ELSE pol.qty END) AS INTEGER) AS "sold_units",
          CAST(COUNT(DISTINCT pos.name) AS INTEGER) AS "cnt_invoices"
      FROM odoohonduras."pos_order_line" pol
          INNER JOIN odoohonduras."pos_order" pos ON pol.order_id = pos.id
          INNER JOIN odoohonduras.res_branch_res_users_rel es ON pol.create_uid = es.res_users_id 
          LEFT JOIN odoohonduras.product_product AS pp ON pol.product_id = pp.id
          LEFT JOIN odoohonduras.product_template AS pt ON pp.product_tmpl_id = pt.id
          JOIN odoohonduras.product_category AS pc ON pt.categ_id = pc.id
          LEFT JOIN odoohonduras.res_branch rb ON es.res_branch_id = rb.id       
      WHERE pos.create_date BETWEEN timestamp '${format(startDate, 'yyyy-MM-dd')} 05:00:00' AND timestamp '${format(endDate, 'yyyy-MM-dd')} 04:59:59'
          AND pos.state = 'invoiced'
      GROUP BY rb.name, pol.create_uid;
    `;

  const result = await executeSQLMethod(query);
  const conversionRate = await getConversionRate();

  // Obtener nombres de columnas
  const columns = ["#", "store", "sales", "sold_units", "cnt_invoices", "ticketpr", "sales_growth", "units_growth", "invoices_growth", "sales_usd", "ticketpr_usd"];

  const data = result.map((item, index) => {
    const saleshn = parseFloat((item.sales || "0").replace(/,/g, ''));
    const salesUsd = parseFloat((saleshn / conversionRate).toFixed(2));
    const cnt_invoices = parseFloat((item.cnt_invoices || "0").replace(/,/g, '')) || 1;
    const ticketprhn = Math.round(saleshn / cnt_invoices);
    const ticketprUsd = Math.round(salesUsd / cnt_invoices);
    return {
        "#": index + 1,
        ...item,
        sales_usd: salesUsd.toLocaleString('en-US'),
        ticketpr: ticketprhn,
        ticketpr_usd: ticketprUsd.toLocaleString('en-US')
    };
  });

  // Verificación de resultados vacíos
  if (!data || data.length === 0) {
    throw new Error('La consulta SQL retornó resultados vacíos.');
  }

  return { columns, data };
};

// Función principal para generar el contenido del email
const tableEmailAccumulated = async () => {
  const today = new Date();
  let ini_month = startOfMonth(today);

  // Verifica si la fecha actual es el primer día del mes
  if (getDate(today) === 1) {
    ini_month = startOfMonth(subMonths(today, 1));
  }

  const primer_dia_mes_siguiente = addMonths(ini_month, 1);
  const yesterday = subDays(today, 1);

  let columnsAccumulated, dataAccumulated, columnsDaily, dataDaily;
  try {
    ({ columns: columnsAccumulated, data: dataAccumulated } = await executeSQLQuery(ini_month, primer_dia_mes_siguiente));
    ({ columns: columnsDaily, data: dataDaily } = await executeSQLQuery(yesterday, today));
  } catch (error) {
    throw error; // Propagar el error para que sea capturado en el bloque principal
  }

  // Filtrado de datos para "CANAL MODERNO" y otros stores
  const filterCanalModerno = data => data.filter(item => item["store"] === "CANAL MODERNO")
    .map(item => ({ ...item, "store": "CANAL MODERNO" }));
  const filterOtherStores = data => data.filter(item => item["store"] !== "CANAL MODERNO");

  const dataAccumulatedCanalModerno = filterCanalModerno(dataAccumulated);
  const dataAccumulatedOtherStores = filterOtherStores(dataAccumulated);
  const dataDailyCanalModerno = filterCanalModerno(dataDaily);
  const dataDailyOtherStores = filterOtherStores(dataDaily);

  const reindexData = (data) => data.map((item, index) => ({ ...item, "#": index + 1 }));

  const reindexedAccumulatedOtherStores = reindexData(dataAccumulatedOtherStores);
  const reindexedDailyOtherStores = reindexData(dataDailyOtherStores);
  const reindexedAccumulatedCanalModerno = reindexData(dataAccumulatedCanalModerno);
  const reindexedDailyCanalModerno = reindexData(dataDailyCanalModerno);

  // Función para crear la tabla HTML
  function createHTMLTable(columns, data, title, iconUrl) {
    // Calcular totales
    let totals = {
      "#": '',
      store: 'Total',
      sales: 0,
      sold_units: 0,
      cnt_invoices: 0,
      ticketpr: 0,
      sales_growth: 0,
      units_growth: 0,
      invoices_growth: 0,
      sales_usd: 0,
      ticketpr_usd: 0
    };

    data.forEach(item => {
      totals.sales += parseFloat((parseFloat((item.sales || "0").replace(',', '')) || 0).toFixed(2));
      totals.sold_units += Math.round(parseFloat((item.sold_units || "0").replace(/,/g, '')) || 0);
      totals.cnt_invoices += Math.round(parseFloat((item.cnt_invoices || "0").replace(/,/g, '')) || 0);
      // Asumiendo que sales_growth, units_growth, invoices_growth son calculados en otro lugar o se agregan posteriormente
      totals.sales_growth += Math.round(parseFloat((item.sales_growth || "0").replace(/,/g, '')) || 0);
      totals.units_growth += Math.round(parseFloat((item.units_growth || "0").replace(/,/g, '')) || 0);
      totals.invoices_growth += Math.round(parseFloat((item.invoices_growth || "0").replace(/,/g, '')) || 0);
      totals.sales_usd += parseFloat((parseFloat((item.sales_usd || "0").replace(/,/g, '')) || 0).toFixed(2));
      totals.ticketpr_usd += Math.round(parseFloat((item.ticketpr_usd || "0").replace(/,/g, '')) || 0);
    });

    // Calcular promedio para tasas de crecimiento si aplica
    let numRecords = data.length;
    totals.sales_growth = numRecords > 0 ? (totals.sales_growth / numRecords).toFixed(2) : 0;
    totals.units_growth = numRecords > 0 ? (totals.units_growth / numRecords).toFixed(2) : 0;
    totals.invoices_growth = numRecords > 0 ? (totals.invoices_growth / numRecords).toFixed(2) : 0;
    totals.ticketpr = totals.cnt_invoices > 0 ? Math.round(totals.sales / totals.cnt_invoices) : 0;
    totals.ticketpr_usd = totals.cnt_invoices > 0 ? Math.round(totals.sales_usd / totals.cnt_invoices) : 0;

    let html = '<div style="padding: 20px; border: 4px solid #D3D3E9; border-radius: 15px; text-align: left; width: fit-content;">';
    html += `<p style="background-color:#D8D8EB; padding: 10px 20px; color:#3D3D7A; width: fit-content; border-radius: 15px; font-weight:500; margin: 0 0 0 6px; text-align: center;">`;
    html += `<img src="${iconUrl}" style="width:20px; height:15px; margin-right: 10px; vertical-align: middle;">`;
    html += `${title} ${subDays(today, 1).toLocaleString('es-CO', { locale: es, day: 'numeric', month: 'long' }).toUpperCase()}</p><br>`;
    html += '<table style="border-collapse:collapse; font-family: Arial; font-size: 12px; border-radius: 15px;"><thead><tr>';

    // Crear encabezados de la tabla
    html += '<th style="padding:10px;border:1px solid #000;background-color:#d8d8d8;color:#000000; font-size: 12px; text-align: center;">#</th>';
    html += '<th style="padding:10px;border:1px solid #000;background-color:#d8d8d8;color:#000000; font-size: 12px; text-align: center;">Store</th>';
    html += '<th style="padding:10px;border:1px solid #000;background-color:#bad4aa;color:#000000; font-size: 12px; text-align: center;">Día 2025 (HNL)</th>';
    html += '<th style="padding:10px;border:1px solid #000;background-color:#bad4aa;color:#000000; font-size: 12px; text-align: center;">Día 2025 (USD)</th>';
    html += '<th style="padding:10px;border:1px solid #000;background-color:#d4d4aa;color:#000000; font-size: 12px; text-align: center;">Unid 2025</th>';
    html += '<th style="padding:10px;border:1px solid #000;background-color:#fec57e;color:#000000; font-size: 12px; text-align: center;">Trx 2025</th>';
    html += '<th style="padding:10px;border:1px solid #000;background-color:#88b5c4;color:#000000; font-size: 12px; text-align: center;">Ticketpr 2025 (HNL)</th>';
    html += '<th style="padding:10px;border:1px solid #000;background-color:#88b5c4;color:#000000; font-size: 12px; text-align: center;">Ticketpr 2025 (USD)</th>';
    html += '</tr></thead><tbody>';

    // Crear filas de la tabla
    data.forEach((item, index) => {
      let backgroundColor = index % 2 === 0 ? '#F9F9FC' : '#EDEDF5';
      html += `<tr style="background-color: ${backgroundColor};">`;

      html += `<td style="padding:10px;border:1px solid #000;color:#000; background-color:#f2f2f2; font-weight:300; text-align: left;">${item["#"] || ''}</td>`;
      html += `<td style="padding:10px;border:1px solid #000;color:#000; background-color:#f2f2f2; font-weight:300; text-align: left;">${item.store || ''}</td>`;
      html += `<td style="padding:10px;border:1px solid #000;color:#000; background-color:#ebf5df; font-weight:300; text-align: right;">${item.sales || ''}</td>`;
      html += `<td style="padding:10px;border:1px solid #000;color:#000; background-color:#ebf5df; font-weight:300; text-align: right;">${item.sales_usd || ''}</td>`;
      html += `<td style="padding:10px;border:1px solid #000;color:#000; background-color:#e4e4c9; font-weight:300; text-align: right;">${item.sold_units || ''}</td>`;
      html += `<td style="padding:10px;border:1px solid #000;color:#000; background-color:#feead1; font-weight:300; text-align: right;">${item.cnt_invoices || ''}</td>`;
      html += `<td style="padding:10px;border:1px solid #000;color:#000; background-color:#b9e6ec; font-weight:300; text-align: right;">${item.ticketpr || ''}</td>`;
      html += `<td style="padding:10px;border:1px solid #000;color:#000; background-color:#b9e6ec; font-weight:300; text-align: right;">${item.ticketpr_usd || ''}</td>`;
      html += '</tr>';
    });

    // Añadir fila de totales
    html += '<tr style="background-color: #d8d8d8; font-weight: bold;">';
    html += `<td style="padding:10px;border:1px solid #000;color:#000; text-align: left;">${totals["#"]}</td>`;
    html += `<td style="padding:10px;border:1px solid #000;color:#000; text-align: left;">${totals.store}</td>`;
    html += `<td style="padding:10px;border:1px solid #000;color:#000; text-align: right;">${totals.sales.toLocaleString('es-CO')}</td>`;
    html += `<td style="padding:10px;border:1px solid #000;color:#000; text-align: right;">${totals.sales_usd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>`;
    html += `<td style="padding:10px;border:1px solid #000;color:#000; text-align: right;">${totals.sold_units.toLocaleString()}</td>`;
    html += `<td style="padding:10px;border:1px solid #000;color:#000; text-align: right;">${totals.cnt_invoices.toLocaleString()}</td>`;
    html += `<td style="padding:10px;border:1px solid #000;color:#000; text-align: right;">${totals.ticketpr}</td>`;
    html += `<td style="padding:10px;border:1px solid #000;color:#000; text-align: right;">${totals.ticketpr_usd.toLocaleString('en-US')}</td>`;
    html += '</tr>';

    html += '</tbody></table></div>';
    return html;
  }

  // Crear las tablas HTML individuales
  const accumulatedHtml = createHTMLTable(columnsAccumulated, dataAccumulatedOtherStores, `INFORME ACUMULADO DEL ${format(ini_month, 'd').toUpperCase()} AL `, 'https://upload.wikimedia.org/wikipedia/commons/thumb/8/82/Flag_of_Honduras.svg/1920px-Flag_of_Honduras.svg.png');
  const dailyHtml = createHTMLTable(columnsDaily, dataDailyOtherStores, `INFORME FECHA A FECHA`, 'https://upload.wikimedia.org/wikipedia/commons/thumb/8/82/Flag_of_Honduras.svg/1920px-Flag_of_Honduras.svg.png');

  // Concatenar todas las tablas en el contenido final del email
  const html = dailyHtml + '<br><br>' + accumulatedHtml ;

  return {
    html
  };
};

// Función para enviar el correo electrónico principal
const emailhnd = async (html, csvData) => {
  const transporter = nodemailer.createTransport({
    SES: ses,
  });

  const params = {
    from: 'comunicaciones.sistemas@fastmoda.com.co 🇭🇳 Venta_Lili_Honduras',
    to: ['yeimy.jimenez@fastmoda.com.co',
      'kevin.castillo@fastmoda.com.co',
      'andres.hernandez@fastmoda.com.co',
      'marcela.montenegro@lilipink.hn',
      'daniela.velasquez@lilipink.hn',
      'nassim@dvpty.com',
      'david@lilipink.com'],
    // to: ['yeimy.jimenez@fastmoda.com.co'],
    subject: 'Informe de ventas Honduras',
    html: html,
  };

  try {
    const info = await transporter.sendMail(params);
    console.log('Correo enviado exitosamente:', info);
  } catch (error) {
    console.error('Error al enviar el correo:', error);
    throw error; // Re-lanzar el error para que pueda ser capturado en el bloque principal
  }
};

// Función exportada que maneja el envío de correos
exports.emailhnd = async () => {
  try {
    const { html, csvData } = await tableEmailAccumulated();
    await emailhnd(html, csvData);
    console.log("Correo enviado correctamente.");
  } catch (error) {
    console.error("Error al procesar el correo:", error);
    await sendErrorEmail(error);
    console.log("Correo de error enviado ");
  }
};

