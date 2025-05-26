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
    from: 'cristian.supelano@fastmoda.com.co 🇲🇽 Venta_Lili_Mexico',
    to: ['cristian.supelano@fastmoda.com.co'], // Puedes agregar más destinatarios si lo deseas
    subject: 'Error en el Informe de Ventas México',
    html: `<p>Ha ocurrido un error al ejecutar el informe de ventas México:</p><p>${error.message}</p>`,
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

    let queryStatus = 'QUEUED';
    while (queryStatus === 'QUEUED' || queryStatus === 'RUNNING') {
      const queryExecution = await athena.getQueryExecution({ QueryExecutionId: queryExecutionId }).promise();
      queryStatus = queryExecution.QueryExecution.Status.State;
      if (queryStatus === 'FAILED' || queryStatus === 'CANCELLED') {
        console.error(`Query execution failed or was cancelled: ${queryExecutionId}`);
        console.error('Reason:', queryExecution.QueryExecution.Status.StateChangeReason);
        throw new Error(`Query execution failed or was cancelled: ${queryExecutionId}`);
      }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    const queryResults = await athena.getQueryResults({ QueryExecutionId: queryExecutionId }).promise();
    const columns = queryResults.ResultSet.ResultSetMetadata.ColumnInfo.map(column => column.Name);
    const rows = queryResults.ResultSet.Rows.slice(1);
    const results = rows.map(row => {
      const result = {};
      row.Data.forEach((value, index) => {
        result[columns[index]] = value.VarCharValue;
      });
      return result;
    });

    return results;
  } catch (error) {
    console.error('Error executing SQL query:', error);
    throw error;
  }
};

// Función para obtener la tasa de conversión USD a MXN
const getConversionRate = async () => {
  try {
    const response = await fetch('https://open.er-api.com/v6/latest/USD');
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    const data = await response.json();
    const rates = data.rates;
    const mxnToUsdRate = rates['MXN'];
    if (!mxnToUsdRate) {
      throw new Error('No se pudo obtener la tasa de conversión MXN a USD.');
    }
    return 1 / mxnToUsdRate;
  } catch (error) {
    console.error('Error fetching conversion rate:', error);
    throw error;
  }
};

// Función para ejecutar la consulta SQL con fechas
const executeSQLQuery = async (startDate, endDate) => {
  const ini_month_past_year = subYears(startDate, 1);
  const fin_month_past_year = format(subYears(endDate, 1), 'yyyy-MM-dd');

  const query = ` 
      SELECT
          COALESCE("store") AS "store",
          FORMAT('%,.2f', ROUND(SUM(subquery."Dia 2025"), 2)) AS "sales",
          CAST(SUM(subquery."Unid 2025") AS INT) AS "sold_units",
          COALESCE(SUM(subquery."Txr 2025"), 0) AS "cnt_invoices",
          CASE 
              WHEN COALESCE(SUM(subquery."Txr 2025"), 0) <> 0 THEN CAST(COALESCE((SUM(subquery."Dia 2025") * -1) / SUM(subquery."Txr 2025"), 0) AS INTEGER)
              ELSE 0
          END AS "ticketpr"
      FROM (
          SELECT
              q1."store",
              SUM(q1."Dia 2025") AS "Dia 2025",
              SUM(q1."Unid 2025") AS "Unid 2025",
              SUM(q1."Txr 2025") AS "Txr 2025"
          FROM (
              SELECT
                  (pc.name) AS "store",
                  SUM(pol.price_subtotal) AS "Dia 2025",
                  ROUND(SUM(pol.qty),2) AS "Unid 2025",
                  COUNT(DISTINCT po.name) AS "Txr 2025"
              FROM "odoomexico"."pos_order" po
                JOIN "odoomexico"."pos_order_line" pol ON po.id = pol.order_id
                JOIN "odoomexico"."pos_session" ps ON po.session_id = ps.id
                JOIN "odoomexico"."pos_config" pc ON ps.config_id = pc.id
              WHERE pol.create_date BETWEEN TIMESTAMP '${format(startDate, 'yyyy-MM-dd')} 05:00:00' AND TIMESTAMP '${format(endDate, 'yyyy-MM-dd')} 04:59:59'
              GROUP BY pc.name, po.name
          ) AS q1
          GROUP BY q1."store"
      ) AS subquery
      GROUP BY subquery."store";`;

  const result = await executeSQLMethod(query);
  const conversionRate = await getConversionRate();

  const columns = ["#", "store", "sales", "sold_units", "cnt_invoices", "ticketpr", "sales_growth", "units_growth", "invoices_growth", "sales_usd", "ticketpr_usd"];

  const data = result.map((item, index) => {
    const salesMxn = parseFloat((item.sales || "0").replace(/,/g, '')) || 0;
    const salesUsd = parseFloat((salesMxn * conversionRate).toFixed(2)) || 0;
    const cnt_invoices = parseFloat((item.cnt_invoices || "0").replace(/,/g, '')) || 1;
    const ticketprMxn = Math.round(salesMxn / cnt_invoices);
    const ticketprUsd = Math.round(salesUsd / cnt_invoices);
    return { 
      "#": index + 1, 
      ...item, 
      ticketpr: ticketprMxn.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 }), 
      sales_usd: salesUsd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }), 
      ticketpr_usd: ticketprUsd.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 }) 
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

  // Filtrado de datos para "CANAL MODERNO" y otros stores (si aplica)
  // Puedes ajustar o eliminar este filtrado según tus necesidades
  // const filterCanalModerno = data => data.filter(item => item["store"] === "CANAL MODERNO")
  //   .map(item => ({ ...item, "store": "CANAL MODERNO" }));
  // const filterOtherStores = data => data.filter(item => item["store"] !== "CANAL MODERNO");

  // const dataAccumulatedCanalModerno = filterCanalModerno(dataAccumulated);
  // const dataAccumulatedOtherStores = filterOtherStores(dataAccumulated);
  // const dataDailyCanalModerno = filterCanalModerno(dataDaily);
  // const dataDailyOtherStores = filterOtherStores(dataDaily);

  // Si no necesitas filtrar, simplemente usa los datos
  const reindexedAccumulated = dataAccumulated; // Puedes reindexar si es necesario
  const reindexedDaily = dataDaily; // Puedes reindexar si es necesario

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
      totals.sales += parseFloat((item.sales || "0").replace(/,/g, '')) || 0;
      totals.sold_units += parseFloat((item.sold_units || "0").replace(/,/g, '')) || 0;
      totals.cnt_invoices += parseFloat((item.cnt_invoices || "0").replace(/,/g, '')) || 0;
      totals.sales_growth += parseFloat((item.sales_growth || "0").replace(/,/g, '')) || 0;
      totals.units_growth += parseFloat((item.units_growth || "0").replace(/,/g, '')) || 0;
      totals.invoices_growth += parseFloat((item.invoices_growth || "0").replace(/,/g, '')) || 0;
      totals.sales_usd += parseFloat((item.sales_usd || "0").replace(/,/g, '')) || 0;
      totals.ticketpr_usd += parseFloat((item.ticketpr_usd || "0").replace(/,/g, '')) || 0;
    });

    // Calcular promedio para tasas de crecimiento si aplica
    let numRecords = data.length;
    totals.sales_growth = numRecords > 0 ? (totals.sales_growth / numRecords).toFixed(2) : 0;
    totals.units_growth = numRecords > 0 ? (totals.units_growth / numRecords).toFixed(2) : 0;
    totals.invoices_growth = numRecords > 0 ? (totals.invoices_growth / numRecords).toFixed(2) : 0;
    totals.ticketpr = totals.cnt_invoices > 0 ? (totals.sales / totals.cnt_invoices).toFixed(0) : 0;
    totals.ticketpr_usd = totals.cnt_invoices > 0 ? (totals.sales_usd / totals.cnt_invoices).toFixed(0) : 0;

    let html = '<div style="padding: 20px; border: 4px solid #D3D3E9; border-radius: 15px; text-align: left; width: fit-content;">';
    html += `<p style="background-color:#D8D8EB; padding: 10px 20px; color: #3D3D7A; width: fit-content; border-radius: 15px; font-weight:500; margin: 0 0 0 6px; text-align: center;">`;
    html += `<img src="${iconUrl}" style="width:20px; height:15px; margin-right: 10px; vertical-align: middle;">`;
    html += `${title} ${subDays(today, 1).toLocaleString('es-CO', { locale: es, day: 'numeric', month: 'long' }).toUpperCase()}</p><br>`;
    html += '<table style="border-collapse:collapse; font-family: Arial; font-size: 12px; border-radius: 15px;"><thead><tr>';

    // Crear encabezados de la tabla
    html += '<th style="padding:10px;border:1px solid #000;background-color:#DFDFDF;color:#000000; font-size: 12px; text-align: center;">#</th>';
    html += '<th style="padding:10px;border:1px solid #000;background-color:#DFDFDF;color:#000000; font-size: 12px; text-align: center;">Store</th>';
    html += '<th style="padding:10px;border:1px solid #000;background-color:#006847;color:#ffffff; font-size: 12px; text-align: center; max-width: 60px;">Día 2025 (MXN)</th>';
    html += '<th style="padding:10px;border:1px solid #000;background-color:#006847;color:#ffffff; font-size: 12px; text-align: center; max-width: 60px;">Día 2025 (USD)</th>';
    html += '<th style="padding:10px;border:1px solid #000;background-color:#EFEFEE;color:#000000; font-size: 12px; text-align: center; max-width: 60px;">Unid 2025</th>';
    html += '<th style="padding:10px;border:1px solid #000;background-color:#EFEFEE;color:#000000; font-size: 12px; text-align: center; max-width: 60px;">Trx 2025</th>';
    html += '<th style="padding:10px;border:1px solid #000;background-color:#D3492C;color:#ffffff; font-size: 12px; text-align: center; max-width: 60px;">Ticketpr 2025 (MXN)</th>';
    html += '<th style="padding:10px;border:1px solid #000;background-color:#D3492C;color:#ffffff; font-size: 12px; text-align: center; max-width: 60px;">Ticketpr 2025 (USD)</th>';
    html += '</tr></thead><tbody>';

    // Crear filas de la tabla
    data.forEach((item, index) => {
      let backgroundColor = index % 2 === 0 ? '#F9F9FC' : '#EDEDF5';
      html += `<tr style="background-color: ${backgroundColor};">`;

      html += `<td style="padding:10px;border:1px solid #000;color:#000; background-color:#F9F9FC; font-weight:300; text-align: left;">${item["#"] || ''}</td>`;
      html += `<td style="padding:10px;border:1px solid #000;color:#000; background-color:#F9F9FC; font-weight:300; text-align: left;">${item.store || ''}</td>`;
      html += `<td style="padding:10px;border:1px solid #000;color:#000; background-color:#ECFFE4; font-weight:300; text-align: right;">${item.sales || ''}</td>`;
      html += `<td style="padding:10px;border:1px solid #000;color:#000; background-color:#ECFFE4; font-weight:300; text-align: right;">${item.sales_usd || ''}</td>`;
      html += `<td style="padding:10px;border:1px solid #000;color:#000; background-color:#ffffff; font-weight:300; text-align: right;">${item.sold_units || ''}</td>`;
      html += `<td style="padding:10px;border:1px solid #000;color:#000; background-color:#ffffff; font-weight:300; text-align: right;">${item.cnt_invoices || ''}</td>`;
      html += `<td style="padding:10px;border:1px solid #000;color:#000; background-color:#FFE4E4; font-weight:300; text-align: right;">${item.ticketpr || ''}</td>`;
      html += `<td style="padding:10px;border:1px solid #000;color:#000; background-color:#FFE4E4; font-weight:300; text-align: right;">${item.ticketpr_usd || ''}</td>`;

      html += '</tr>';
    });

    // Añadir fila de totales
    html += '<tr style="background-color: #DFDFDF; font-weight: bold;">';
    html += `<td style="padding:10px;border:1px solid #000;color:#000; text-align: left;">${totals["#"]}</td>`;
    html += `<td style="padding:10px;border:1px solid #000;color:#000; text-align: left;">${totals.store}</td>`;
    html += `<td style="padding:10px;border:1px solid #000;color:#000; text-align: right;">${totals.sales.toLocaleString('es-CO')}</td>`;
    html += `<td style="padding:10px;border:1px solid #000;color:#000; text-align: right;">${totals.sales_usd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>`;
    html += `<td style="padding:10px;border:1px solid #000;color:#000; text-align: right;">${totals.sold_units.toLocaleString()}</td>`;
    html += `<td style="padding:10px;border:1px solid #000;color:#000; text-align: right;">${totals.cnt_invoices.toLocaleString()}</td>`;
    html += `<td style="padding:10px;border:1px solid #000;color:#000; text-align: right;">${totals.ticketpr}</td>`;
    html += `<td style="padding:10px;border:1px solid #000;color:#000; text-align: right;">${totals.ticketpr_usd.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}</td>`;

    html += '</tr>';

    html += '</tbody></table></div>';
    return html;
  }

  // Crear las tablas HTML individuales
  const accumulatedHtml = createHTMLTable(
    columnsAccumulated, 
    reindexedAccumulated, 
    `INFORME ACUMULADO DEL ${format(ini_month, 'd').toUpperCase()} AL `, 
    'https://upload.wikimedia.org/wikipedia/commons/thumb/f/fc/Flag_of_Mexico.svg/1920px-Flag_of_Mexico.svg.png'
  );
  const dailyHtml = createHTMLTable(
    columnsDaily, 
    reindexedDaily, 
    `INFORME FECHA A FECHA`, 
    'https://upload.wikimedia.org/wikipedia/commons/thumb/f/fc/Flag_of_Mexico.svg/1920px-Flag_of_Mexico.svg.png'
  );

  // Concatenar todas las tablas en el contenido final del email
  const html = dailyHtml + '<br><br>' + accumulatedHtml;

  return {
    html
  };
};

// Función para enviar el correo electrónico principal
const emailmxFDEM = async (html, csvData) => {
  const transporter = nodemailer.createTransport({
    SES: ses,
  });

  const params = {
    from: 'cristian.supelano@fastmoda.com.co 🇲🇽 Venta_Lili_Mexico',
    // to: [
    //   'cristian.supelano@fastmoda.com.co',
    //   'yeimy.jimenez@fastmoda.com.co'
    // ],
    to: [
      'cristian.supelano@fastmoda.com.co',
      'yeimy.jimenez@fastmoda.com.co',
      'diego.garcia@fastmoda.com.co',
      'kevin.castillo@fastmoda.com.co',
      'andres.hernandez@fastmoda.com.co',
      'yeimy.angulo@fastmoda.com.co',
      'nassim@dvpty.com',
      'david@lilipink.com'
    ],
    subject: 'Informe de ventas México',
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
exports.emailmxFDEM = async () => {
  try {
    const { html } = await tableEmailAccumulated();
    await emailmxFDEM(html);
    console.log("Correo México enviado correctamente.");
  } catch (error) {
    console.error("Error al procesar el correo:", error);
    await sendErrorEmail(error);
    console.log("Correo de error enviado");
  }
};
