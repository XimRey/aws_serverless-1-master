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
        throw new Error(`La ejecución de la consulta falló o fue cancelada: ${queryExecutionId}`);
      }
      await new Promise(resolve => setTimeout(resolve, 1000)); // Espera 1 segundo antes de verificar nuevamente
    }

    // Una vez que la consulta esté completa, obtener los resultados
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
// TRM del API sin necesidad de usar el ajuste del aumento de la TRM para llegar al 11,30

// const getConversionRate = async () => {
//   try {
//     const response = await fetch('https://open.er-api.com/v6/latest/USD');
//     if (!response.ok) {
//       throw new Error(`Error HTTP! estado: ${response.status}`);
//     }
//     const data = await response.json();
//     const rates = data.rates;
//     const bobToUsdRate = rates['BOB'];
//     return 1 / bobToUsdRate;
//   } catch (error) {
//     console.error('Error obteniendo la tasa de conversión:', error);
//     throw error;
//   }
// };

const getConversionRate = async () => {
  try {
    await fetch('https://open.er-api.com/v6/latest/USD'); // Llama a la API, pero ignora su resultado
    return 11.30; // Siempre devuelve la TRM fija
  } catch (error) {
    console.error('Error obteniendo la tasa de conversión:', error);
    return 11.30; // En caso de error, también devuelve 11.30
  }
};


const executeSQLQuery = async (startDate, endDate) => {
  const ini_month_past_year = subYears(startDate, 1);
  const fin_month_past_year = format(subYears(endDate, 1), 'yyyy-MM-dd');

  const query = `      
      WITH stores_cte AS (
        SELECT DISTINCT CAST(br.id AS VARCHAR) AS "stores"
        FROM odoobolivia.res_users br
        WHERE CAST(br.id AS VARCHAR) IN (
            SELECT DISTINCT CAST(create_uid AS VARCHAR)
            FROM odoobolivia.pos_order_line
            WHERE create_date BETWEEN TIMESTAMP '${format(startDate, 'yyyy-MM-dd')} 05:00:00' AND TIMESTAMP '${format(endDate, 'yyyy-MM-dd')} 04:59:59'
        )
      ),
      q1 AS (
        SELECT
            CAST(br.id AS VARCHAR) AS "stores",
            pc.name AS "store",
            ROUND(SUM(ac.price_subtotal), 2) AS "sales",
            COALESCE(CAST(ROUND(SUM(CASE WHEN ac.create_date BETWEEN TIMESTAMP '${format(startDate, 'yyyy-MM-dd')} 05:00:00' AND TIMESTAMP '${format(endDate, 'yyyy-MM-dd')} 04:59:59' THEN ac.qty END), 0) AS INTEGER), 0) AS "sold_units",
            COALESCE(CAST(COUNT(DISTINCT CASE WHEN ac.create_date BETWEEN TIMESTAMP '${format(startDate, 'yyyy-MM-dd')} 05:00:00' AND TIMESTAMP '${format(endDate, 'yyyy-MM-dd')} 04:59:59' THEN pos.name END) AS INTEGER), 0) AS "cnt_invoices"
        FROM odoobolivia.pos_order_line ac
        INNER JOIN odoobolivia.res_users br ON ac.create_uid = br.id
        INNER JOIN odoobolivia.pos_order pos ON ac.order_id = pos.id
        INNER JOIN odoobolivia.pos_session ps ON pos.session_id = ps.id
        INNER JOIN odoobolivia.pos_config pc ON ps.config_id = pc.id
        WHERE
            pos.state = 'invoiced'
            AND ac.create_date BETWEEN TIMESTAMP '${format(startDate, 'yyyy-MM-dd')} 05:00:00' AND TIMESTAMP '${format(endDate, 'yyyy-MM-dd')} 04:59:59'
        GROUP BY br.id, pc.name
      ),
      q2 AS (
        SELECT
            CAST(br.id AS VARCHAR) AS "stores",
            pc.name AS "store",
            ROUND(SUM(ac.price_subtotal), 2) AS "sales_ly",
            COALESCE(CAST(ROUND(SUM(CASE WHEN ac.create_date BETWEEN TIMESTAMP '${format(startDate, 'yyyy-MM-dd')} 05:00:00' AND TIMESTAMP '${format(endDate, 'yyyy-MM-dd')} 04:59:59' THEN ac.qty END), 0) AS INTEGER), 0) AS "sold_units_ly",
            COALESCE(CAST(COUNT(DISTINCT CASE WHEN ac.create_date BETWEEN TIMESTAMP '${format(startDate, 'yyyy-MM-dd')} 05:00:00' AND TIMESTAMP '${format(endDate, 'yyyy-MM-dd')} 04:59:59' THEN pos.name END) AS INTEGER), 0) AS "cnt_invoices_ly"
        FROM odoobolivia.pos_order_line ac
        INNER JOIN odoobolivia.res_users br ON ac.create_uid = br.id
        INNER JOIN odoobolivia.pos_order pos ON ac.order_id = pos.id
        INNER JOIN odoobolivia.pos_session ps ON pos.session_id = ps.id
        INNER JOIN odoobolivia.pos_config pc ON ps.config_id = pc.id
        WHERE
            pos.state = 'invoiced'
            AND ac.create_date BETWEEN TIMESTAMP '${format(startDate, 'yyyy-MM-dd')} 05:00:00' AND TIMESTAMP '${format(endDate, 'yyyy-MM-dd')} 04:59:59'
        GROUP BY br.id, pc.name
      )
      SELECT
        UPPER(COALESCE(q1."store", q2."store")) AS "store",
        ROUND(SUM(COALESCE(ABS(q2."sales_ly"), 0)), 2) AS "sales_ly",
        ROUND(SUM(COALESCE(ABS(q1."sales"), 0)), 2) AS "sales",
        SUM(COALESCE(ABS(q2."cnt_invoices_ly"), 0)) AS "cnt_invoices_ly",
        SUM(COALESCE(ABS(q1."cnt_invoices"), 0)) AS "cnt_invoices",
        SUM(COALESCE(ABS(q2."sold_units_ly"), 0)) AS "sold_units_ly",
        SUM(COALESCE(ABS(q1."sold_units"), 0)) AS "sold_units"
      FROM stores_cte
      INNER JOIN q1 ON stores_cte."stores" = q1."stores"
      INNER JOIN q2 ON stores_cte."stores" = q2."stores"
      GROUP BY UPPER(COALESCE(q1."store", q2."store"))
      ORDER BY UPPER(COALESCE(q1."store", q2."store"));
   `;
  // console.log(query);
  const result = await executeSQLMethod(query);
  const conversionRate = await getConversionRate();

  // Obtener nombres de columnas
  const columns = ["#", "store", "sales", "sold_units", "cnt_invoices", "ticketpr", "sales_growth", "units_growth", "invoices_growth", "sales_usd", "ticketpr_usd"];

  // Convertir ventas a USD y calcular ticketpr_usd
  const data = result.map((item, index) => {
    const salesbob = parseFloat((item.sales || "0").toString().replace(/,/g, ''));
    const salesUsd = (salesbob / conversionRate).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const ticketprbob = parseFloat((salesbob / item.cnt_invoices).toFixed(0)).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
    const ticketprUsd = parseFloat((salesbob / conversionRate / item.cnt_invoices).toFixed(0)).toLocaleString('en-US');
    return { "#": index + 1, ...item, ticketpr: ticketprbob, sales_usd: salesUsd, ticketpr_usd: ticketprUsd };
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

  // Ejecutar consultas acumulada y diaria
  const { columns: columnsAccumulated, data: dataAccumulated } = await executeSQLQuery(ini_month, primer_dia_mes_siguiente);
  const { columns: columnsDaily, data: dataDaily } = await executeSQLQuery(yesterday, today);

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
      totals.sales += parseFloat((parseFloat((item.sales || "0").replace(/,/g, '')) || 0).toFixed(2));
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

    // Crear encabezados de la tabla
    html += '<th style="padding:10px;border:1px solid #000;background-color:#DFDFDF;color:#000000; font-size: 12px; text-align: center; width: fit-content; margin: 0 auto;">#</th>';
    html += '<th style="padding:10px;border:1px solid #000;background-color:#DFDFDF;color:#000000; font-size: 12px; text-align: center; width: fit-content; margin: 0 auto;">Store</th>';
    html += '<th style="padding:10px;border:1px solid #000;background-color:#D3492C;color:#ffffff; font-size: 12px; text-align: center; width: fit-content; margin: 0 auto; max-width: 60px;">Día 2025 (BOB)</th>';
    html += '<th style="padding:10px;border:1px solid #000;background-color:#D3492C;color:#ffffff; font-size: 12px; text-align: center; width: fit-content; margin: 0 auto; max-width: 60px;">Día 2025 (USD)</th>';
    html += '<th style="padding:10px;border:1px solid #000;background-color:#FFD66F;color:#000000; font-size: 12px; text-align: center; width: fit-content; margin: 0 auto; max-width: 60px;">Unid 2025</th>';
    html += '<th style="padding:10px;border:1px solid #000;background-color:#FFD66F;color:#000000; font-size: 12px; text-align: center; width: fit-content; margin: 0 auto; max-width: 60px;">Trx 2025</th>';
    html += '<th style="padding:10px;border:1px solid #000;background-color:#006847;color:#ffffff; font-size: 12px; text-align: center; width: fit-content; margin: 0 auto; max-width: 60px;">Ticketpr 2025 (BOB)</th>';
    html += '<th style="padding:10px;border:1px solid #000;background-color:#006847;color:#ffffff; font-size: 12px; text-align: center; width: fit-content; margin: 0 auto; max-width: 60px;">Ticketpr 2025 (USD)</th>';
    html += '</tr></thead><tbody>';

    // Crear filas de la tabla
    data.forEach((item, index) => {
      let backgroundColor = index % 2 === 0 ? '#F9F9FC' : '#EDEDF5';
      html += `<tr style="background-color: ${backgroundColor};">`;

      html += `<td style="padding:10px;border:1px solid #000;color:#000; background-color:#F9F9FC; font-weight:300; text-align: left;">${item["#"] || ''}</td>`;
      html += `<td style="padding:10px;border:1px solid #000;color:#000; background-color:#F9F9FC; font-weight:300; text-align: left;">${item.store || ''}</td>`;
      html += `<td style="padding:10px;border:1px solid #000;color:#000; background-color:#FFE4E4; font-weight:300; text-align: right;">${parseFloat(item.sales).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>`;
      // html += `<td style="padding:10px;border:1px solid #000;color:#000; background-color:#FFE4E4; font-weight:300; text-align: right;">${parseFloat(item.sales).toFixed(2)}</td>`;
      html += `<td style="padding:10px;border:1px solid #000;color:#000; background-color:#FFE4E4; font-weight:300; text-align: right;">${item.sales_usd || ''}</td>`;
      html += `<td style="padding:10px;border:1px solid #000;color:#000; background-color:#FFFCDA; font-weight:300; text-align: right;">${item.sold_units || ''}</td>`;
      html += `<td style="padding:10px;border:1px solid #000;color:#000; background-color:#FFFCDA; font-weight:300; text-align: right;">${item.cnt_invoices || ''}</td>`;
      html += `<td style="padding:10px;border:1px solid #000;color:#000; background-color:#ECFFE4; font-weight:300; text-align: right;">${item.ticketpr || ''}</td>`;
      html += `<td style="padding:10px;border:1px solid #000;color:#000; background-color:#ECFFE4; font-weight:300; text-align: right;">${item.ticketpr_usd || ''}</td>`;

      html += '</tr>';
    });

    // Añadir fila de totales
    html += '<tr style="background-color: #DFDFDF; font-weight: bold;">';
    html += `<td style="padding:10px;border:1px solid #000;color:#000; text-align: left;">${totals["#"]}</td>`;
    html += `<td style="padding:10px;border:1px solid #000;color:#000; text-align: left;">${totals.store}</td>`;
    html += `<td style="padding:10px;border:1px solid #000;color:#000; text-align: right;">${parseFloat(totals.sales).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>`;
    // html += `<td style="padding:10px;border:1px solid #000;color:#000; text-align: right;">${parseFloat(totals.sales).toFixed(2)}</td>`;
    html += `<td style="padding:10px;border:1px solid #000;color:#000; text-align: right;">${Math.round(totals.sales_usd).toLocaleString()}</td>`;
    html += `<td style="padding:10px;border:1px solid #000;color:#000; text-align: right;">${totals.sold_units.toLocaleString()}</td>`;
    html += `<td style="padding:10px;border:1px solid #000;color:#000; text-align: right;">${totals.cnt_invoices.toLocaleString()}</td>`;
    html += `<td style="padding:10px;border:1px solid #000;color:#000; text-align: right;">${totals.ticketpr.toLocaleString()}</td>`;
    html += `<td style="padding:10px;border:1px solid #000;color:#000; text-align: right;">${totals.ticketpr_usd.toLocaleString()}</td>`;
    html += '</tr>';

    html += '</tbody></table></div>';
    return html;
  }

  const accumulatedHtml = createHTMLTable(
    columnsAccumulated,
    dataAccumulated,
    `INFORME ACUMULADO DEL ${format(ini_month, 'd').toUpperCase()} AL `,
    'https://upload.wikimedia.org/wikipedia/commons/thumb/4/48/Flag_of_Bolivia.svg/1280px-Flag_of_Bolivia.svg.png'
  );
  const dailyHtml = createHTMLTable(
    columnsDaily,
    dataDaily,
    `INFORME FECHA A FECHA`,
    'https://upload.wikimedia.org/wikipedia/commons/thumb/4/48/Flag_of_Bolivia.svg/1280px-Flag_of_Bolivia.svg.png'
  );

  const html = dailyHtml + '<br><br>' + accumulatedHtml;
  


  return { 
    html,
    dataDaily // Retornar dataDaily para su verificación
  };
};

// Nueva función para enviar correos de error
const sendErrorEmail = async (errorMessage) => {
  const transporter = nodemailer.createTransport({
    SES: ses,
  });

  const params = {
    from: 'comunicaciones.sistemas@fastmoda.com.co 🇧🇴 Venta_Lili_Bolivia',
    to: ['yeimy.jimenez@fastmoda.com.co'],
    subject: 'Error en el Informe de Ventas Bolivia',
    text: errorMessage,
  };

  try {
    const info = await transporter.sendMail(params);
    console.log('Correo de error enviado exitosamente:', info);
  } catch (error) {
    console.error('Error enviando el correo de error:', error);
  }
};

const emailbv = async (html) => {
  const transporter = nodemailer.createTransport({
    SES: ses,
  });

  const params = {
    from: 'comunicaciones.sistemas@fastmoda.com.co 🇧🇴 Venta_Lili_Bolivia',
    // to: ['yeimy.jimenez@fastmoda.com.co'],
    to: ['yeimy.jimenez@fastmoda.com.co',
      'kevin.castillo@fastmoda.com.co',
      'andres.hernandez@fastmoda.com.co',
      'asandi@lilipinkbo.com',
      'ammyribera@lilipinkbo.com',
      'catherine.vergel@fastmoda.com.co',
      'alejandro.mosquera@fastmoda.com.co',
      'nassim@dvpty.com'],
    subject: 'Informe de ventas Bolivia',
    html: html,
  };

  try {
    const info = await transporter.sendMail(params);
    console.log('Correo enviado exitosamente:', info);
  } catch (error) {
    console.log('Error enviando el correo:', error);
    throw error; // Lanzar el error para que sea capturado en el bloque catch externo
  }
};

exports.emailbv = async () => {
  try {
    const { html, dataDaily } = await tableEmailAccumulated();

    // Verificar si dataDaily está vacío
    if (!dataDaily || dataDaily.length === 0) {
      const errorMessage = 'La consulta diaria no devolvió datos o está vacía.';
      console.error(errorMessage);
      await sendErrorEmail(errorMessage);
    } else {
      // Enviar el correo regular
      await emailbv(html);
      console.log("Correo de ventas Bolivia enviado correctamente.");
    }
  } catch (error) {
    // Enviar correo de error en caso de cualquier excepción
    const errorMessage = `Ocurrió un error al procesar el informe de ventas Bolivia: ${error.message}`;
    console.error(errorMessage);
    await sendErrorEmail(errorMessage);
  }
};
