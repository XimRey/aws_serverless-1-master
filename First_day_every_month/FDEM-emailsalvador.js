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
    from: 'cristian.supelano@fastmoda.com.co 🇸🇻 Venta_Lili_El_Salvador',
    to: ['cristian.supelano@fastmoda.com.co'], // Puedes agregar más destinatarios si lo deseas
    subject: 'Error en el Informe de Ventas El Salvador',
    html: `<p>Ha ocurrido un error al ejecutar el informe de ventas El Salvador:</p><p>${error.message}</p>`,
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

    // Espera hasta que la consulta esté completa
    let queryStatus = 'QUEUED';
    while (queryStatus === 'QUEUED' || queryStatus === 'RUNNING') {
      const queryExecution = await athena.getQueryExecution({ QueryExecutionId: queryExecutionId }).promise();
      queryStatus = queryExecution.QueryExecution.Status.State;
      if (queryStatus === 'FAILED' || queryStatus === 'CANCELLED') {
        throw new Error(`La ejecución de la consulta falló o fue cancelada: ${queryExecutionId}`);
      }
      await new Promise(resolve => setTimeout(resolve, 1000)); // Espera 1 segundo antes de verificar nuevamente
    }

    // Una vez completada la consulta, obtener los resultados
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
    console.error('Error ejecutando la consulta SQL:', error);
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
          COALESCE(SUM(subquery."Dia 2025"),0) AS "sales",
          COALESCE(SUM(subquery."Unid 2025"), 0) AS "sold_units",
          COALESCE(SUM(subquery."Txr 2025"), 0) AS "cnt_invoices",
          CASE 
              WHEN COALESCE(SUM(subquery."Txr 2025"), 0) <> 0 THEN CAST(COALESCE((SUM(subquery."Dia 2025")) / SUM(subquery."Txr 2025"), 0) AS INTEGER)
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
              FROM "odoosalvador"."pos_order" po
                JOIN "odoosalvador"."pos_order_line" pol ON po.id = pol.order_id
                JOIN "odoosalvador"."pos_session" ps ON po.session_id = ps.id
                JOIN "odoosalvador"."pos_config" pc ON ps.config_id = pc.id
              WHERE pol.create_date BETWEEN TIMESTAMP '${format(startDate, 'yyyy-MM-dd')} 05:00:00' AND TIMESTAMP '${format(endDate, 'yyyy-MM-dd')} 04:59:59'
              GROUP BY pc.name, po.name
          ) AS q1
          GROUP BY q1."store"
      ) AS subquery
      GROUP BY subquery."store";       
  `;
  console.log('Consulta SQL:', query);
  const result = await executeSQLMethod(query);

  // Obtener nombres de columnas
  const columns = ["#", "store", "sales", "sold_units", "cnt_invoices", "ticketpr", "sales_growth", "units_growth", "invoices_growth"];

  const data = result.map((item, index) => {
    return { "#": index + 1, ...item };
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
    };

    data.forEach(item => {
      totals.sales += parseFloat((parseFloat((item.sales || "0").replace(',', '')) || 0).toFixed(2));
      totals.sold_units += parseInt((item.sold_units || "0").replace(/,/g, '')) || 0;
      totals.cnt_invoices += parseInt((item.cnt_invoices || "0").replace(/,/g, '')) || 0;
      totals.sales_growth += parseInt((item.sales_growth || "0").replace(/,/g, '')) || 0;
      totals.units_growth += parseInt((item.units_growth || "0").replace(/,/g, '')) || 0;
      totals.invoices_growth += parseInt((item.invoices_growth || "0").replace(/,/g, '')) || 0;
    });

    // Calcular promedio para tasas de crecimiento
    let numRecords = data.length;
    totals.sales_growth = numRecords > 0 ? (totals.sales_growth / numRecords).toFixed(0) : 0;
    totals.units_growth = numRecords > 0 ? (totals.units_growth / numRecords).toFixed(0) : 0;
    totals.invoices_growth = numRecords > 0 ? (totals.invoices_growth / numRecords).toFixed(0) : 0;
    totals.ticketpr = totals.cnt_invoices > 0 ? (totals.sales / totals.cnt_invoices).toFixed(0) : 0;

    let html = '<div style="padding: 20px; border: 4px solid #D3D3E9; border-radius: 15px; text-align: left; width: fit-content;">';
    html += `<p style="background-color:#D8D8EB; padding: 10px 20px; color:#3D3D7A; width: fit-content; border-radius: 15px; font-weight:500; margin: 0 0 0 6px; text-align: center;">`;
    html += `<img src="${iconUrl}" style="width:20px; height:15px; margin-right: 10px; vertical-align: middle;">`;
    html += `${title} ${subDays(today, 1).toLocaleString('es-CO', { timeZone: 'America/Bogota', day: 'numeric', month: 'long' }).toUpperCase()}</p><br>`;
    html += '<table style="border-collapse:collapse; font-family: Arial; font-size: 12px; border-radius: 15px;"><thead><tr>';

    // Crear encabezados de la tabla
    html += '<th style="padding:10px;border:1px solid #000;background-color:#bfbfbf;color:#000000; font-size: 12px; text-align: center; width: fit-content; margin: 0 auto;">#</th>';
    html += '<th style="padding:10px;border:1px solid #000;background-color:#bfbfbf;color:#000000; font-size: 12px; text-align: center; width: fit-content; margin: 0 auto;">Store</th>';
    html += '<th style="padding:10px;border:1px solid #000;background-color:#b2f1e4;color:#000000; font-size: 12px; text-align: center; width: fit-content; margin: 0 auto; max-width: 60px;">Día 2025 (USD)</th>';
    html += '<th style="padding:10px;border:1px solid #000;background-color:#b2f1e4;color:#000000; font-size: 12px; text-align: center; width: fit-content; margin: 0 auto; max-width: 60px;">Unid 2025</th>';
    html += '<th style="padding:10px;border:1px solid #000;background-color:#f3e3b1;color:#000000; font-size: 12px; text-align: center; width: fit-content; margin: 0 auto; max-width: 60px;">Trx 2025</th>';
    html += '<th style="padding:10px;border:1px solid #000;background-color:#ffa199;color:#000000; font-size: 12px; text-align: center; width: fit-content; margin: 0 auto; max-width: 60px;">Ticketpr 2025 (USD)</th>';
    html += '</tr></thead><tbody>';

    // Crear filas de la tabla
    data.forEach((item, index) => {
      let backgroundColor = index % 2 === 0 ? '#F9F9FC' : '#EDEDF5';
      html += `<tr style="background-color: ${backgroundColor};">`;

      html += `<td style="padding:10px;border:1px solid #000;color:#000; background-color:#f2f2f2; font-weight:300; text-align: left;">${item["#"] || ''}</td>`;
      html += `<td style="padding:10px;border:1px solid #000;color:#000; background-color:#f2f2f2; font-weight:300; text-align: left;">${item.store || ''}</td>`;
      html += `<td style="padding:10px;border:1px solid #000;color:#000; background-color:#ddf9f3; font-weight:300; text-align: right;">${Number(item.sales || 0).toLocaleString()}</td>`;
      html += `<td style="padding:10px;border:1px solid #000;color:#000; background-color:#ddf9f3; font-weight:300; text-align: right;">${Number(item.sold_units || 0).toLocaleString()}</td>`;
      html += `<td style="padding:10px;border:1px solid #000;color:#000; background-color:#faf3dd; font-weight:300; text-align: right;">${Number(item.cnt_invoices || 0).toLocaleString()}</td>`;
      html += `<td style="padding:10px;border:1px solid #000;color:#000; background-color:#ffd0cc; font-weight:300; text-align: right;">${Number(item.ticketpr || 0).toLocaleString()}</td>`;
      html += '</tr>';
    });

    // Añadir fila de totales
    html += '<tr style="background-color: #bfbfbf; font-weight: bold;">';
    html += `<td style="padding:10px;border:1px solid #000;color:#000; text-align: left;">${totals["#"]}</td>`;
    html += `<td style="padding:10px;border:1px solid #000;color:#000; text-align: left;">${totals.store}</td>`;
    html += `<td style="padding:10px;border:1px solid #000;color:#000; text-align: right;">${totals.sales.toLocaleString()}</td>`;
    html += `<td style="padding:10px;border:1px solid #000;color:#000; text-align: right;">${totals.sold_units.toLocaleString()}</td>`;
    html += `<td style="padding:10px;border:1px solid #000;color:#000; text-align: right;">${totals.cnt_invoices.toLocaleString()}</td>`;
    html += `<td style="padding:10px;border:1px solid #000;color:#000; text-align: right;">${Number(totals.ticketpr).toLocaleString()}</td>`;
    html += '</tr>';

    html += '</tbody></table></div>';
    return html;
  }

  // Función para crear la tabla de totales HTML (si necesitas tablas adicionales de totales)
  // Puedes eliminar o ajustar esta función si no es necesaria
  /*
  function createTotalHTMLTable(totals, title, iconUrl) {
    // Implementación similar a createHTMLTable si necesitas tablas de totales
  }
  */

  const accumulatedHtml = createHTMLTable(
    columnsAccumulated,
    dataAccumulated,
    `INFORME ACUMULADO DEL ${format(ini_month, 'd').toUpperCase()} AL `,
    'https://upload.wikimedia.org/wikipedia/commons/thumb/3/34/Flag_of_El_Salvador.svg/1920px-Flag_of_El_Salvador.svg.png'
  );
  const dailyHtml = createHTMLTable(
    columnsDaily,
    dataDaily,
    `INFORME FECHA A FECHA`,
    'https://upload.wikimedia.org/wikipedia/commons/thumb/3/34/Flag_of_El_Salvador.svg/1920px-Flag_of_El_Salvador.svg.png'
  );

  // Concatenar todas las tablas en el contenido final del email
  const html = dailyHtml + '<br><br>' + accumulatedHtml;

  return {
    // csvData, // Si no utilizas csvData, puedes eliminarlo
    html
  };
};

// Función para enviar el correo electrónico principal
const emailsvFDEM = async (html) => {
  const transporter = nodemailer.createTransport({
    SES: ses,
  });

  const params = {
    from: 'cristian.supelano@fastmoda.com.co 🇸🇻 Venta_Lili_El_Salvador',
    to: [
      'cristian.supelano@fastmoda.com.co',
      'yeimy.jimenez@fastmoda.com.co',
      'diego.garcia@fastmoda.com.co',
      'kevin.castillo@fastmoda.com.co',
      'andres.hernandez@fastmoda.com.co',
      'marcela.montenegro@lilipink.hn',
      'daniela.velasquez@lilipink.hn',
      'catherine.vergel@fastmoda.com.co',
      'nassim@dvpty.com',
      'david@lilipink.com'
    ],
    subject: 'Informe de ventas El Salvador',
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
exports.emailsvFDEM = async () => {
  try {
    const { html } = await tableEmailAccumulated();
    await emailsvFDEM(html);
    console.log("Correo enviado correctamente.");
  } catch (error) {
    console.error("Error al procesar el correo:", error);
    await sendErrorEmail(error);
    console.log("Correo de error enviado ");
  }
};
