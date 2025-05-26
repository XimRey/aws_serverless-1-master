'use strict';
const { athena, ses } = require('../configurations/awsSetting');
const nodemailer = require('nodemailer');
const { format, subDays, startOfMonth, addMonths, subYears, getDate, subMonths } = require('date-fns');
const { es } = require('date-fns/locale');

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

    // Wait until query is complete
    let queryStatus = 'QUEUED';
    while (queryStatus === 'QUEUED' || queryStatus === 'RUNNING') {
      const queryExecution = await athena.getQueryExecution({ QueryExecutionId: queryExecutionId }).promise();
      queryStatus = queryExecution.QueryExecution.Status.State;
      if (queryStatus === 'FAILED' || queryStatus === 'CANCELLED') {
        throw new Error(`Query execution failed or was cancelled: ${queryExecutionId}`);
      }
      await new Promise(resolve => setTimeout(resolve, 1000)); // Wait for 1 second before checking status again
    }

    // Once query is complete, get the results
    const queryResults = await athena.getQueryResults({ QueryExecutionId: queryExecutionId }).promise();
    const columns = queryResults.ResultSet.ResultSetMetadata.ColumnInfo.map(column => column.Name);
    const rows = queryResults.ResultSet.Rows.slice(1); // Ignore first row which contains column names
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

const getConversionRate = async () => {
  try {
    const response = await fetch('https://open.er-api.com/v6/latest/USD');
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    const data = await response.json();
    const rates = data.rates;
    const vesToUsdRate = rates['VES'];
    return 1 / vesToUsdRate;
  } catch (error) {
    console.error('Error fetching conversion rate:', error);
    throw error;
  }
};

const executeSQLQuery = async (startDate, endDate) => {
  const ini_month_past_year = subYears(startDate, 1);
  const fin_month_past_year = format(subYears(endDate, 1), 'yyyy-MM-dd');

  const query = `
    SELECT
        'TIENDAS_PROPIAS' AS "type",
        q3."c_descripcion" AS "store",
        REPLACE(REPLACE(REGEXP_REPLACE(format('%,.0f', ROUND(SUM(COALESCE(q2."totalventasperiodo1", 0)), 2)), ',', 'TEMP'), '.', ','), 'TEMP', '.') AS "sales_ly",
        REGEXP_REPLACE(CAST(SUM(COALESCE(q2."totalunidadesperiodo1", 0)) AS VARCHAR), ',', '.') AS "sold_units_ly",
        REGEXP_REPLACE(CAST(SUM(COALESCE(q2."cnt_invoices_ly", 0)) AS VARCHAR), ',', '.') AS "cnt_invoices_ly",
        REPLACE(REPLACE(REGEXP_REPLACE(format('%,.0f', ROUND(SUM(COALESCE(q1."totalventasperiodo2", 0)), 2)), ',', 'TEMP'), '.', ','), 'TEMP', '.') AS "sales",
        REGEXP_REPLACE(CAST(SUM(CAST(COALESCE(q1."totalunidadesperiodo2", 0) AS BIGINT)) AS VARCHAR), ',', '.') AS "sold_units",
        REGEXP_REPLACE(CAST(SUM(COALESCE(q1."cnt_invoices", 0)) AS VARCHAR), ',', '.') AS "cnt_invoices",
        REPLACE(REPLACE(REGEXP_REPLACE(format('%,.0f', ROUND(SUM(COALESCE(q1."ticketpr", 0)), 2)), ',', 'TEMP'), '.', ','), 'TEMP', '.') AS "ticketpr",
        CASE
            WHEN SUM(COALESCE(q2."totalventasperiodo1", 0)) = 0 THEN '100'
            WHEN SUM(COALESCE(q1."totalventasperiodo2", 0)) = 0 THEN '100'
            ELSE format('%s', CAST(ROUND(((SUM(COALESCE(q1."totalventasperiodo2", 0)) - SUM(COALESCE(q2."totalventasperiodo1", 0))) / NULLIF(SUM(COALESCE(q2."totalventasperiodo1", 1)), 0)) * 100, 2) AS DECIMAL(15,2)))
        END as "sales_growth",
        CASE
            WHEN SUM(COALESCE(q2."totalunidadesperiodo1", 0)) = 0 THEN '100'
            WHEN SUM(COALESCE(q1."totalunidadesperiodo2", 0)) = 0 THEN '100'
            ELSE format('%s', CAST(ROUND(((SUM(COALESCE(q1."totalunidadesperiodo2", 0)) - SUM(COALESCE(q2."totalunidadesperiodo1", 0))) / NULLIF(SUM(COALESCE(q2."totalunidadesperiodo1", 1)), 0)) * 100, 2) AS DECIMAL(15,2)))
        END as "units_growth",
        CASE
            WHEN SUM(COALESCE(q2."cnt_invoices_ly", 0)) = 0 THEN '100'
            WHEN SUM(COALESCE(q1."cnt_invoices", 0)) = 0 THEN '100'
            ELSE format('%s', CAST(ROUND(((SUM(COALESCE(q1."cnt_invoices", 0)) - SUM(COALESCE(q2."cnt_invoices_ly", 0))) / NULLIF(SUM(COALESCE(q2."cnt_invoices_ly", 1)), 0)) * 100, 2) AS DECIMAL(15,2)))
        END as "invoices_growth"
    FROM (
        SELECT 
            CAST(vad20.c_localidad AS VARCHAR) AS "c_localidad",
            vad10.c_descripcion
        FROM 
            "venezuela-stellar"."vad20-ma_transaccion" vad20
        JOIN
            "venezuela-stellar"."vad10-ma_sucursales" vad10
        ON vad20.c_localidad = vad10.c_codigo
        WHERE 
            vad20.c_concepto = 'VEN'
            AND CAST(vad20.f_fecha AS timestamp) BETWEEN TIMESTAMP '${format(startDate, 'yyyy-MM-dd')}' AND TIMESTAMP '${format(endDate, 'yyyy-MM-dd')}'
        GROUP BY vad10.c_descripcion, vad20.c_localidad
    ) AS q3
    LEFT JOIN (
        SELECT
            CAST(c_localidad AS VARCHAR) AS "c_localidad",
            COALESCE(SUM(CASE WHEN CAST(f_fecha AS timestamp) BETWEEN TIMESTAMP '${format(startDate, 'yyyy-MM-dd')}' AND TIMESTAMP '${format(endDate, 'yyyy-MM-dd')}' THEN Total END), 0.0) AS "totalventasperiodo2",
            COALESCE(SUM(CASE WHEN CAST(f_fecha AS timestamp) BETWEEN TIMESTAMP '${format(startDate, 'yyyy-MM-dd')}' AND TIMESTAMP '${format(endDate, 'yyyy-MM-dd')}' THEN cantidad END), 0) AS "totalunidadesperiodo2",
            COALESCE(COUNT(DISTINCT CASE WHEN CAST(f_fecha AS timestamp) BETWEEN TIMESTAMP '${format(startDate, 'yyyy-MM-dd')}' AND TIMESTAMP '${format(endDate, 'yyyy-MM-dd')}' THEN ID END), 0) AS "cnt_invoices",
            COALESCE(ROUND(SUM(CASE WHEN CAST(f_fecha AS timestamp) BETWEEN TIMESTAMP '${format(startDate, 'yyyy-MM-dd')}' AND TIMESTAMP '${format(endDate, 'yyyy-MM-dd')}' THEN Total * 1.12 END) / NULLIF(COUNT(CASE WHEN CAST(f_fecha AS timestamp) BETWEEN TIMESTAMP '${format(startDate, 'yyyy-MM-dd')}' AND TIMESTAMP '${format(endDate, 'yyyy-MM-dd')}' THEN c_localidad END), 0)), 0.0) AS "ticketpr"
        FROM "venezuela-stellar"."vad20-ma_transaccion"
        WHERE c_concepto = 'VEN'
            AND CAST(f_fecha AS timestamp) BETWEEN TIMESTAMP '${format(startDate, 'yyyy-MM-dd')}' AND TIMESTAMP '${format(endDate, 'yyyy-MM-dd')}'
        GROUP BY c_localidad
    ) AS q1 ON q3."c_localidad" = q1."c_localidad"
    LEFT JOIN (
        SELECT
            CAST(c_localidad AS VARCHAR) AS "c_localidad",
            COALESCE(SUM(CASE WHEN CAST(f_fecha AS timestamp) BETWEEN TIMESTAMP '${format(ini_month_past_year, 'yyyy-MM-dd')}' AND TIMESTAMP '${fin_month_past_year}' THEN Total END), 0.0) AS "totalventasperiodo1",
            COALESCE(SUM(CASE WHEN CAST(f_fecha AS timestamp) BETWEEN TIMESTAMP '${format(ini_month_past_year, 'yyyy-MM-dd')}' AND TIMESTAMP '${fin_month_past_year}' THEN cantidad END), 0) AS "totalunidadesperiodo1",
            COALESCE(COUNT(DISTINCT CASE WHEN CAST(f_fecha AS timestamp) BETWEEN TIMESTAMP '${format(ini_month_past_year, 'yyyy-MM-dd')}' AND TIMESTAMP '${fin_month_past_year}' THEN ID END), 0) AS "cnt_invoices_ly",
            COALESCE(ROUND(SUM(CASE WHEN CAST(f_fecha AS timestamp) BETWEEN TIMESTAMP '${format(ini_month_past_year, 'yyyy-MM-dd')}' AND TIMESTAMP '${fin_month_past_year}' THEN Total * 1.12 END) / NULLIF(COUNT(CASE WHEN CAST(f_fecha AS timestamp) BETWEEN TIMESTAMP '${format(ini_month_past_year, 'yyyy-MM-dd')}' AND TIMESTAMP '${fin_month_past_year}' THEN c_localidad END), 0)), 0.0) AS "Ticketpr2024"
        FROM "venezuela-stellar"."vad20-ma_transaccion"
        WHERE c_concepto = 'VEN'
            AND CAST(f_fecha AS timestamp) BETWEEN TIMESTAMP '${format(ini_month_past_year, 'yyyy-MM-dd')}' AND TIMESTAMP '${fin_month_past_year}'
        GROUP BY c_localidad
    ) AS q2 ON q3."c_localidad" = q2."c_localidad"
    GROUP BY q3."c_descripcion"
    ORDER BY q3."c_descripcion" ASC;
  `;
  const result = await executeSQLMethod(query);
  const conversionRate = await getConversionRate();

  // Get column names
  const columns = ["#", "store", "sales", "sold_units", "cnt_invoices", "ticketpr", "sales_growth", "units_growth", "invoices_growth", "sales_usd", "ticketpr_usd"];

  const data = result.map((item, index) => {
    // Parse sales value correctly by removing dots as thousand separators and then parse as float
    const salesves = parseFloat((item.sales || "0").replace(/\./g, '').replace(',', '.'));
    const salesUsd = parseFloat((salesves * conversionRate).toFixed(2)).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const ticketprves = parseFloat((item.ticketpr || "0").replace(/\./g, '').replace(',', '.'));
    const ticketprUsd = parseFloat((ticketprves * conversionRate).toFixed(2)).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return { "#": index + 1, ...item, sales_usd: salesUsd, ticketpr_usd: ticketprUsd };
  });

  return { columns, data };
};

const tableEmailAccumulated = async () => {
  const today = new Date();
  let ini_month = startOfMonth(today);

  // Verifica si la fecha actual es el primer día del mes
  if (getDate(today) === 1) {
    ini_month = startOfMonth(subMonths(today, 1));
  }

  const primer_dia_mes_siguiente = addMonths(ini_month, 1);
  const yesterday = subDays(today, 1);

  const { columns: columnsAccumulated, data: dataAccumulated } = await executeSQLQuery(ini_month, primer_dia_mes_siguiente);
  const { columns: columnsDaily, data: dataDaily } = await executeSQLQuery(yesterday, today);

  // Function to create HTML table
  function createHTMLTable(columns, data, title, iconUrl) {
    // Calculate totals
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
      totals.sales += parseFloat((item.sales || "0").replace(/\./g, '').replace(',', '.')) || 0;
      totals.sold_units += parseFloat((item.sold_units || "0").replace(/,/g, '')) || 0;
      totals.cnt_invoices += parseFloat((item.cnt_invoices || "0").replace(/,/g, '')) || 0;
      totals.sales_growth += parseFloat((item.sales_growth || "0").replace(/,/g, '')) || 0;
      totals.units_growth += parseFloat((item.units_growth || "0").replace(/,/g, '')) || 0;
      totals.invoices_growth += parseFloat((item.invoices_growth || "0").replace(/,/g, '')) || 0;
      totals.sales_usd += parseFloat((item.sales_usd || "0").replace(/,/g, '')) || 0;
      totals.ticketpr_usd += parseFloat((item.ticketpr_usd || "0").replace(/,/g, '')) || 0;
    });

    // Calculate average for growth rates
    let numRecords = data.length;
    totals.sales_growth = (totals.sales_growth / numRecords).toFixed(2);
    totals.units_growth = (totals.units_growth / numRecords).toFixed(2);
    totals.invoices_growth = (totals.invoices_growth / numRecords).toFixed(2);
    totals.ticketpr = (totals.sales / totals.cnt_invoices).toFixed(2);
    totals.ticketpr_usd = (totals.sales_usd / totals.cnt_invoices).toFixed(2);

    let html = '<div style="padding: 20px; border: 4px solid #D3D3E9; border-radius: 15px; text-align: left; width: fit-content;">';
    html += `<p style="background-color:#D8D8EB; padding: 10px 20px; color: #3D3D7A; width: fit-content; border-radius: 15px; font-weight:500; margin: 0 0 0 6px; text-align: center;">`;
    html += `<img src="${iconUrl}" style="width:20px; height:15px; margin-right: 10px; vertical-align: middle;">`;
    html += `${title} ${subDays(today, 1).toLocaleString('es-CO', { timeZone: 'America/Bogota', day: 'numeric', month: 'long' }).toUpperCase()}</p><br>`;
    html += '<table style="border-collapse:collapse; font-family: Arial; font-size: 12px; border-radius: 15px;"><thead><tr>';

    // Create table headers
    html += '<th style="padding:10px;border:1px solid #000;background-color:#DFDFDF;color:#000000; font-size: 12px; text-align: center; width: fit-content; margin: 0 auto;">#</th>';
    html += '<th style="padding:10px;border:1px solid #000;background-color:#DFDFDF;color:#000000; font-size: 12px; text-align: center; width: fit-content; margin: 0 auto;">Store</th>';
    html += '<th style="padding:10px;border:1px solid #000;background-color:#FFD66F;color:#000000; font-size: 12px; text-align: center; width: fit-content; margin: 0 auto; max-width: 60px;">Día 2025 (VES)</th>';
    html += '<th style="padding:10px;border:1px solid #000;background-color:#FFD66F;color:#000000; font-size: 12px; text-align: center; width: fit-content; margin: 0 auto; max-width: 60px;">Día 2025 (USD)</th>';
    html += '<th style="padding:10px;border:1px solid #000;background-color:#0056E4;color:#ffffff; font-size: 12px; text-align: center; width: fit-content; margin: 0 auto; max-width: 60px;">Unid 2025</th>';
    html += '<th style="padding:10px;border:1px solid #000;background-color:#0056E4;color:#ffffff; font-size: 12px; text-align: center; width: fit-content; margin: 0 auto; max-width: 60px;">Trx 2025</th>';
    html += '<th style="padding:10px;border:1px solid #000;background-color:#900C3F;color:#ffffff; font-size: 12px; text-align: center; width: fit-content; margin: 0 auto; max-width: 60px;">Ticketpr 2025 (VES)</th>';
    html += '<th style="padding:10px;border:1px solid #000;background-color:#900C3F;color:#ffffff; font-size: 12px; text-align: center; width: fit-content; margin: 0 auto; max-width: 60px;">Ticketpr 2025 (USD)</th>';
    html += '</tr></thead><tbody>';

    // Create table rows
    data.forEach((item, index) => {
      let backgroundColor = index % 2 === 0 ? '#F9F9FC' : '#EDEDF5';
      html += `<tr style="background-color: ${backgroundColor};">`;

      html += `<td style="padding:10px;border:1px solid #000;color:#000; background-color:#F9F9FC; font-weight:300; text-align: left;">${item["#"] || ''}</td>`;
      html += `<td style="padding:10px;border:1px solid #000;color:#000; background-color:#F9F9FC; font-weight:300; text-align: left;">${item.store || ''}</td>`;
      html += `<td style="padding:10px;border:1px solid #000;color:#000; background-color:#FFFCDA; font-weight:300; text-align: right;">${item.sales || ''}</td>`;
      html += `<td style="padding:10px;border:1px solid #000;color:#000; background-color:#FFFCDA; font-weight:300; text-align: right;">${item.sales_usd || ''}</td>`;
      html += `<td style="padding:10px;border:1px solid #000;color:#000; background-color:#DAF2FF; font-weight:300; text-align: right;">${item.sold_units || ''}</td>`;
      html += `<td style="padding:10px;border:1px solid #000;color:#000; background-color:#DAF2FF; font-weight:300; text-align: right;">${item.cnt_invoices || ''}</td>`;
      html += `<td style="padding:10px;border:1px solid #000;color:#000; background-color:#FFE4E4; font-weight:300; text-align: right;">${item.ticketpr || ''}</td>`;
      html += `<td style="padding:10px;border:1px solid #000;color:#000; background-color:#FFE4E4; font-weight:300; text-align: right;">${item.ticketpr_usd || ''}</td>`;
      html += '</tr>';
    });

    // Add totals row
    html += '<tr style="background-color: #DFDFDF; font-weight: bold;">';
    html += `<td style="padding:10px;border:1px solid #000;color:#000; text-align: left;">${totals["#"]}</td>`;
    html += `<td style="padding:10px;border:1px solid #000;color:#000; text-align: left;">${totals.store}</td>`;
    html += `<td style="padding:10px;border:1px solid #000;color:#000; text-align: right;">${totals.sales.toLocaleString()}</td>`;
    html += `<td style="padding:10px;border:1px solid #000;color:#000; text-align: right;">${totals.sales_usd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>`;
    html += `<td style="padding:10px;border:1px solid #000;color:#000; text-align: right;">${totals.sold_units.toLocaleString()}</td>`;
    html += `<td style="padding:10px;border:1px solid #000;color:#000; text-align: right;">${totals.cnt_invoices.toLocaleString()}</td>`;
    html += `<td style="padding:10px;border:1px solid #000;color:#000; text-align: right;">${totals.ticketpr}</td>`;
    html += `<td style="padding:10px;border:1px solid #000;color:#000; text-align: right;">${totals.ticketpr_usd.toLocaleString()}</td>`;
    html += '</tr>';

    html += '</tbody></table></div>';
    return html;
  }

  const accumulatedHtml = createHTMLTable(columnsAccumulated, dataAccumulated, `INFORME ACUMULADO DEL ${format(ini_month, 'd').toUpperCase()} AL `, 'https://upload.wikimedia.org/wikipedia/commons/thumb/0/06/Flag_of_Venezuela.svg/1280px-Flag_of_Venezuela.svg.png');
  const dailyHtml = createHTMLTable(columnsDaily, dataDaily, `INFORME FECHA A FECHA`, 'https://upload.wikimedia.org/wikipedia/commons/thumb/0/06/Flag_of_Venezuela.svg/1280px-Flag_of_Venezuela.svg.png');

  const html = dailyHtml + '<br><br>' + accumulatedHtml ;

  return {
    // csvData,
    html
  };
};

const emailveM6 = async (html, csvData) => {
  const transporter = nodemailer.createTransport({
    SES: ses,
  });

  const params = {
    from: 'cristian.supelano@fastmoda.com.co 🇻🇪 Venta_Lili_Venezuela',
    // to: ['cristian.supelano@fastmoda.com.co','yeimy.jimenez@fastmoda.com.co','diego.garcia@fastmoda.com.co','andres.hernandez@fastmoda.com.co','michel@lilipinkcr.com','admin@lilipinkcr.com','daniel.zeledon@lilipinkcr.com','sharon.benzaquen@lilipinkcr.com','brigitte.cabezas@lilipinkcr.com'],
    to: ['cristian.supelano@fastmoda.com.co'],
    subject: 'Informe de ventas venezuela',
    html: html,
  };

  try {
    const info = await transporter.sendMail(params);
    console.log('Email sent successfully:', info);
  } catch (error) {
    console.log('Error sending email:', error);
  }
};

exports.emailveM6 = async () => {
  const { html, csvData } = await tableEmailAccumulated();
  await emailveM6(html, csvData);
  console.log("Correo envido");
};
