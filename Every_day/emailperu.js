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

const getConversionRate = async () => {
  try {
    const response = await fetch('https://open.er-api.com/v6/latest/USD');
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    const data = await response.json();
    const rates = data.rates;
    const penToUsdRate = rates['PEN'];
    return 1 / penToUsdRate;
  } catch (error) {
    console.error('Error fetching conversion rate:', error);
    throw error;
  }
};

const executeSQLQuery = async (startDate, endDate) => {
  const ini_month_past_year = subYears(startDate, 1);
  const fin_month_past_year = format(subYears(endDate, 1), 'yyyy-MM-dd');

  const query = ` 
      WITH periodo1 AS (
            SELECT 
                store_name,
                store_departament,
                SUM(total_quantity) AS total_quantity_p1,
                SUM(total_price) AS total_price_p1,
                COUNT(DISTINCT number) AS store_count_p1
            FROM 
                "dbperu"."pe_invoices_sales"
            WHERE 
                CAST(document_date AS TIMESTAMP) BETWEEN  TIMESTAMP '${format(startDate, 'yyyy-MM-dd')}' AND TIMESTAMP '${format(endDate, 'yyyy-MM-dd')}'
            GROUP BY store_name, store_departament
        ),
        periodo2 AS (
            SELECT 
                store_name,
                store_departament,
                SUM(total_quantity) AS total_quantity_p2, 
                SUM(total_price) AS total_price_p2,
                COUNT(DISTINCT number) AS store_count_p2
            FROM 
                "dbperu"."pe_invoices_sales"
            WHERE 
                CAST(document_date AS TIMESTAMP) BETWEEN  TIMESTAMP '${format(startDate, 'yyyy-MM-dd')}' AND TIMESTAMP '${format(endDate, 'yyyy-MM-dd')}'
            GROUP BY store_name, store_departament
        )
        SELECT 
            'TIENDAS_PROPIAS' AS "type",
            p2.store_departament AS "store",  
            p2.store_name AS "store_id",
            ROUND(COALESCE(p1.total_price_p1, 0), 2) AS "sales_ly",
            ROUND(COALESCE(p1.total_quantity_p1, 0), 0) AS "sold_units_ly",
            COALESCE(p1.store_count_p1, 0) AS "cnt_invoices_ly",
            ROUND(COALESCE(p2.total_price_p2, 0), 2) AS "sales",
            ROUND(COALESCE(p2.total_quantity_p2, 0), 0) AS "sold_units",
            COALESCE(p2.store_count_p2, 0) AS "cnt_invoices",
            ROUND(COALESCE(p2.total_price_p2, 0) / NULLIF(p2.store_count_p2, 0), 0) AS "ticketpr",

            CASE
                WHEN COALESCE(p1.total_price_p1, 0) = 0 THEN 100
                ELSE ROUND(((COALESCE(p2.total_price_p2, 0) - COALESCE(p1.total_price_p1, 0)) / NULLIF(COALESCE(p1.total_price_p1, 1), 0)) * 100, 2)
            END AS "sales_growth",

            CASE
                WHEN COALESCE(p1.total_quantity_p1, 0) = 0 THEN 100
                ELSE ROUND(((COALESCE(p2.total_quantity_p2, 0) - COALESCE(p1.total_quantity_p1, 0)) / NULLIF(COALESCE(p1.total_quantity_p1, 1), 0)) * 100, 2)
            END AS "units_growth",

            CASE
                WHEN COALESCE(p1.store_count_p1, 0) = 0 THEN 100
                ELSE ROUND(((COALESCE(p2.store_count_p2, 0) - COALESCE(p1.store_count_p1, 0)) / NULLIF(COALESCE(p1.store_count_p1, 1), 0)) * 100, 2)
            END AS "invoices_growth"
        FROM 
            periodo1 p1
        FULL OUTER JOIN 
            periodo2 p2 ON p1.store_name = p2.store_name AND p1.store_departament = p2.store_departament
        ORDER BY 
            p2.store_name;`
  ;
  const result = await executeSQLMethod(query);
  const conversionRate = await getConversionRate();

  const columns = ["#", "store", "sales", "sold_units", "cnt_invoices", "ticketpr", "sales_growth", "units_growth", "invoices_growth", "sales_usd", "ticketpr_usd"];

  const data = result.map((item, index) => {
    const salespen = parseFloat((item.sales || "0").replace(/,/g, ''));
    const salesUsd = parseFloat((salespen * conversionRate).toFixed(2));;
    const ticketprpen = parseFloat((salespen / item.cnt_invoices).toFixed(0)).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
    const ticketprUsd = parseFloat((salesUsd / item.cnt_invoices).toFixed(0)).toString();
    // Convertir sold_units a entero sin decimales
    item.sold_units = parseInt(parseFloat(item.sold_units || "0")).toString();

    // Formatear 'sales' y 'sales_usd' con separadores de miles y dos decimales
    item.sales = salespen.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const salesUsdFormatted = salesUsd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

    // Formatear 'ticketpr_usd' si es necesario
    const ticketprUsdFormatted = ticketprUsd.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });

    return { "#": index + 1, ...item, ticketpr: ticketprpen, sales_usd: salesUsdFormatted, ticketpr_usd: ticketprUsdFormatted };
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

  function createHTMLTable(columns, data, title, iconUrl) {
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

    let numRecords = data.length;
    totals.sales_growth = (totals.sales_growth / numRecords).toFixed(2);
    totals.units_growth = (totals.units_growth / numRecords).toFixed(2);
    totals.invoices_growth = (totals.invoices_growth / numRecords).toFixed(2);
    totals.ticketpr = (totals.sales / totals.cnt_invoices).toFixed(0);
    totals.ticketpr_usd = (totals.sales_usd / totals.cnt_invoices).toFixed(0);

    let html = '<div style="padding: 20px; border: 4px solid #D3D3E9; border-radius: 15px; text-align: left; width: fit-content;">';
    html += `<p style="background-color:#D8D8EB; padding: 10px 20px; color: #3D3D7A; width: fit-content; border-radius: 15px; font-weight:500; margin: 0 0 0 6px; text-align: center;">`;
    html += `<img src="${iconUrl}" style="width:20px; height:15px; margin-right: 10px; vertical-align: middle;">`;
    html += `${title} ${subDays(today, 1).toLocaleString('es-CO', { timeZone: 'America/Bogota', day: 'numeric', month: 'long' }).toUpperCase()}</p><br>`;
    html += '<table style="border-collapse:collapse; font-family: Arial; font-size: 12px; border-radius: 15px;"><thead><tr>';

    html += '<th style="padding:10px;border:1px solid #000;background-color:#DFDFDF;color:#000000; font-size: 12px; text-align: center; width: fit-content; margin: 0 auto;">#</th>';
    html += '<th style="padding:10px;border:1px solid #000;background-color:#DFDFDF;color:#000000; font-size: 12px; text-align: center; width: fit-content; margin: 0 auto;">Store</th>';
    html += '<th style="padding:10px;border:1px solid #000;background-color:#D3492C;color:#ffffff; font-size: 12px; text-align: center; width: fit-content; margin: 0 auto; max-width: 60px;">Día 2025 (PEN)</th>';
    html += '<th style="padding:10px;border:1px solid #000;background-color:#D3492C;color:#ffffff; font-size: 12px; text-align: center; width: fit-content; margin: 0 auto; max-width: 60px;">Día 2025 (USD)</th>';
    html += '<th style="padding:10px;border:1px solid #000;background-color:#EFEFEE;color:#000000; font-size: 12px; text-align: center; width: fit-content; margin: 0 auto; max-width: 60px;">Unid 2025</th>';
    html += '<th style="padding:10px;border:1px solid #000;background-color:#EFEFEE;color:#000000; font-size: 12px; text-align: center; width: fit-content; margin: 0 auto; max-width: 60px;">Trx 2025</th>';
    html += '<th style="padding:10px;border:1px solid #000;background-color:#D3492C;color:#ffffff; font-size: 12px; text-align: center; width: fit-content; margin: 0 auto; max-width: 60px;">Ticketpr 2025 (PEN)</th>';
    html += '<th style="padding:10px;border:1px solid #000;background-color:#D3492C;color:#ffffff; font-size: 12px; text-align: center; width: fit-content; margin: 0 auto; max-width: 60px;">Ticketpr 2025 (USD)</th>';
    html += '</tr></thead><tbody>';

    data.forEach((item, index) => {
      let backgroundColor = index % 2 === 0 ? '#F9F9FC' : '#EDEDF5';
      html += `<tr style="background-color: ${backgroundColor};">`;

      html += `<td style="padding:10px;border:1px solid #000;color:#000; background-color:#F9F9FC; font-weight:300; text-align: left;">${item["#"] || ''}</td>`;
      html += `<td style="padding:10px;border:1px solid #000;color:#000; background-color:#F9F9FC; font-weight:300; text-align: left;">${item.store || ''}</td>`;
      html += `<td style="padding:10px;border:1px solid #000;color:#000; background-color:#FFE4E4; font-weight:300; text-align: right;">${item.sales || ''}</td>`;
      html += `<td style="padding:10px;border:1px solid #000;color:#000; background-color:#FFE4E4; font-weight:300; text-align: right;">${item.sales_usd || ''}</td>`;
      html += `<td style="padding:10px;border:1px solid #000;color:#000; background-color:#ffffff; font-weight:300; text-align: right;">${item.sold_units || ''}</td>`;
      html += `<td style="padding:10px;border:1px solid #000;color:#000; background-color:#ffffff; font-weight:300; text-align: right;">${item.cnt_invoices || ''}</td>`;
      html += `<td style="padding:10px;border:1px solid #000;color:#000; background-color:#FFE4E4; font-weight:300; text-align: right;">${item.ticketpr || ''}</td>`;
      html += `<td style="padding:10px;border:1px solid #000;color:#000; background-color:#FFE4E4; font-weight:300; text-align: right;">${item.ticketpr_usd || ''}</td>`;

      html += '</tr>';
    });

    html += '<tr style="background-color: #DFDFDF; font-weight: bold;">';
    html += `<td style="padding:10px;border:1px solid #000;color:#000; text-align: left;">${totals["#"]}</td>`;
    html += `<td style="padding:10px;border:1px solid #000;color:#000; text-align: left;">${totals.store}</td>`;
    html += `<td style="padding:10px;border:1px solid #000;color:#000; text-align: right;">${totals.sales.toLocaleString()}</td>`;
    html += `<td style="padding:10px;border:1px solid #000;color:#000; text-align: right;">${totals.sales_usd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>`;
    html += `<td style="padding:10px;border:1px solid #000;color:#000; text-align: right;">${totals.sold_units.toLocaleString()}</td>`;
    html += `<td style="padding:10px;border:1px solid #000;color:#000; text-align: right;">${totals.cnt_invoices.toLocaleString()}</td>`;
    html += `<td style="padding:10px;border:1px solid #000;color:#000; text-align: right;">${totals.ticketpr}</td>`;
    html += `<td style="padding:10px;border:1px solid #000;color:#000; text-align: right;">${totals.ticketpr_usd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>`;
    html += '</tr>';

    html += '</tbody></table></div>';
    return html;
  }

  const accumulatedHtml = createHTMLTable(columnsAccumulated, dataAccumulated, `INFORME ACUMULADO DEL ${format(ini_month, 'd').toUpperCase()} AL `, 'https://upload.wikimedia.org/wikipedia/commons/thumb/c/cf/Flag_of_Peru.svg/1280px-Flag_of_Peru.svg.png');
  const dailyHtml = createHTMLTable(columnsDaily, dataDaily, `INFORME FECHA A FECHA`, 'https://upload.wikimedia.org/wikipedia/commons/thumb/c/cf/Flag_of_Peru.svg/1280px-Flag_of_Peru.svg.png');

  const html = dailyHtml + '<br><br>' + accumulatedHtml;

  return {
    html
  };
};

const emailpe = async (html, csvData) => {
  const transporter = nodemailer.createTransport({
    SES: ses,
  });

  const params = {
    from: 'comunicaciones.sistemas@fastmoda.com.co 🇵🇪 Venta_Lili_Perú',
    to: ['yeimy.jimenez@fastmoda.com.co',
      'kevin.castillo@fastmoda.com.co',
      'andres.hernandez@fastmoda.com.co',
      'yeimy.angulo@fastmoda.com.co',
      'nassim@dvpty.com'],
    // to: ['yeimy.jimenez@fastmoda.com.co'],
    subject: 'Informe de ventas perú',
    html: html,
  };

  try {
    const info = await transporter.sendMail(params);
    console.log('Email sent successfully:', info);
  } catch (error) {
    console.log('Error sending email:', error);
  }
};

exports.emailpe = async () => {
  const { html } = await tableEmailAccumulated();
  await emailpe(html);
  console.log("Correo perú enviadas");
};
