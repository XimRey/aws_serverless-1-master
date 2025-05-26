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
    const hnToUsdRate = rates['HNL'];
    return hnToUsdRate;
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
          REGEXP_REPLACE(rb.name, '(\w)(\w*)', x -> upper(x[1]) || lower(x[2])) AS "store",
          FORMAT('%,.2f', ROUND(SUM(ac.price_subtotal), 2)) AS "sales",
          CAST(SUM(ac.qty) AS INTEGER) AS "sold_units",
          CAST(COUNT(DISTINCT pos.name) AS INTEGER) AS "cnt_invoices"
      FROM odoohonduras."pos_order_line" ac
          INNER JOIN odoohonduras."pos_order" pos ON ac.order_id = pos.id
          INNER JOIN odoohonduras.res_branch_res_users_rel es ON ac.create_uid = es.res_users_id 
          LEFT JOIN odoohonduras.res_branch rb ON es.res_branch_id = rb.id       
      WHERE pos.create_date BETWEEN timestamp '${format(startDate, 'yyyy-MM-dd')} 05:00:00' AND timestamp '${format(endDate, 'yyyy-MM-dd')} 04:59:59'
          AND pos.state = 'invoiced'
      GROUP BY rb.name, ac.create_uid;
    `;

  const result = await executeSQLMethod(query);
  const conversionRate = await getConversionRate();

  // Get column names
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
      totals.sales += parseFloat((parseFloat((item.sales || "0").replace(',', '')) || 0).toFixed(2));
      totals.sold_units += Math.round(parseFloat((item.sold_units || "0").replace(/,/g, '')) || 0);
      totals.cnt_invoices += Math.round(parseFloat((item.cnt_invoices || "0").replace(/,/g, '')) || 0);
      totals.sales_growth += Math.round(parseFloat((item.sales_growth || "0").replace(/,/g, '')) || 0);
      totals.units_growth += Math.round(parseFloat((item.units_growth || "0").replace(/,/g, '')) || 0);
      totals.invoices_growth += Math.round(parseFloat((item.invoices_growth || "0").replace(/,/g, '')) || 0);
      totals.sales_usd += parseFloat((parseFloat((item.sales_usd || "0").replace(/,/g, '')) || 0).toFixed(2));
      totals.ticketpr_usd += Math.round(parseFloat((item.ticketpr_usd || "0").replace(/,/g, '')) || 0);
  });
    
    // Calculate average for growth rates
    let numRecords = data.length;
    totals.sales_growth = (totals.sales_growth / numRecords).toFixed(2);
    totals.units_growth = (totals.units_growth / numRecords).toFixed(2);
    totals.invoices_growth = (totals.invoices_growth / numRecords).toFixed(2);
    totals.ticketpr = Math.round(totals.sales / totals.cnt_invoices);
    totals.ticketpr_usd = Math.round(totals.sales_usd / totals.cnt_invoices);


    let html = '<div style="padding: 20px; border: 4px solid #D3D3E9; border-radius: 15px; text-align: left; width: fit-content;">';
    html += `<p style="background-color:#D8D8EB; padding: 10px 20px; color: #3D3D7A; width: fit-content; border-radius: 15px; font-weight:500; margin: 0 0 0 6px; text-align: center;">`;
    html += `<img src="${iconUrl}" style="width:20px; height:15px; margin-right: 10px; vertical-align: middle;">`;
    html += `${title} ${subDays(today, 1).toLocaleString('es-CO', { timeZone: 'America/Bogota', day: 'numeric', month: 'long' }).toUpperCase()}</p><br>`;
    html += '<table style="border-collapse:collapse; font-family: Arial; font-size: 12px; border-radius: 15px;"><thead><tr>';

    // Create table headers
    html += '<th style="padding:10px;border:1px solid #000;background-color:#d8d8d8;color:#000000; font-size: 12px; text-align: center; width: fit-content; margin: 0 auto;">#</th>';
    html += '<th style="padding:10px;border:1px solid #000;background-color:#d8d8d8;color:#000000; font-size: 12px; text-align: center; width: fit-content; margin: 0 auto;">Store</th>';
    html += '<th style="padding:10px;border:1px solid #000;background-color:#bad4aa;color:#000000; font-size: 12px; text-align: center; width: fit-content; margin: 0 auto; max-width: 60px;">Día 2025 (HNL)</th>';
    html += '<th style="padding:10px;border:1px solid #000;background-color:#bad4aa;color:#000000; font-size: 12px; text-align: center; width: fit-content; margin: 0 auto; max-width: 60px;">Día 2025 (USD)</th>';
    html += '<th style="padding:10px;border:1px solid #000;background-color:#d4d4aa;color:#000000; font-size: 12px; text-align: center; width: fit-content; margin: 0 auto; max-width: 60px;">Unid 2025</th>';
    html += '<th style="padding:10px;border:1px solid #000;background-color:#fec57e;color:#000000; font-size: 12px; text-align: center; width: fit-content; margin: 0 auto; max-width: 60px;">Trx 2025</th>';
    html += '<th style="padding:10px;border:1px solid #000;background-color:#88b5c4;color:#000000; font-size: 12px; text-align: center; width: fit-content; margin: 0 auto; max-width: 60px;">Ticketpr 2025 (HNL)</th>';
    html += '<th style="padding:10px;border:1px solid #000;background-color:#88b5c4;color:#000000; font-size: 12px; text-align: center; width: fit-content; margin: 0 auto; max-width: 60px;">Ticketpr 2025 (USD)</th>';
    html += '</tr></thead><tbody>';

    // Create table rows
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

    // Add totals row
    html += '<tr style="background-color: #d8d8d8; font-weight: bold;">';
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

  const accumulatedHtml = createHTMLTable(columnsAccumulated, dataAccumulated, `INFORME ACUMULADO DEL ${format(ini_month, 'd').toUpperCase()} AL `, 'https://upload.wikimedia.org/wikipedia/commons/thumb/8/82/Flag_of_Honduras.svg/1920px-Flag_of_Honduras.svg.png');
  const dailyHtml = createHTMLTable(columnsDaily, dataDaily, `INFORME FECHA A FECHA`, 'https://upload.wikimedia.org/wikipedia/commons/thumb/8/82/Flag_of_Honduras.svg/1920px-Flag_of_Honduras.svg.png');

  const html = dailyHtml + '<br><br>' + accumulatedHtml ;

  return {
    // csvData,
    html
  };
};

const emailhnM6 = async (html, csvData) => {
  const transporter = nodemailer.createTransport({
    SES: ses,
  });

  const params = {
    from: 'cristian.supelano@fastmoda.com.co 🇭🇳 Venta_Lili_Honduras',
    to: ['cristian.supelano@fastmoda.com.co','yeimy.jimenez@fastmoda.com.co','diego.garcia@fastmoda.com.co','andres.hernandez@fastmoda.com.co','michel@lilipinkcr.com','admin@lilipinkcr.com','daniel.zeledon@lilipinkcr.com','sharon.benzaquen@lilipinkcr.com','brigitte.cabezas@lilipinkcr.com','bernardino.oliva@lilipink.hn'], 
    // to: ['cristian.supelano@fastmoda.com.co'], 
    subject: 'Informe de ventas honduras',
    html: html,
  };

  try {
    const info = await transporter.sendMail(params);
    console.log('Email sent successfully:', info);
  } catch (error) {
    console.log('Error sending email:', error);
  }
};

exports.emailhnM6 = async () => {
  const { html, csvData } = await tableEmailAccumulated();
  await emailhnM6(html, csvData);
  console.log("Correo envido");
};
