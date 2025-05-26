'use strict';
const { athena, ses } = require('../configurations/awsSetting');
const nodemailer = require('nodemailer');
const { format, subDays, startOfMonth, addMonths, subYears, endOfMonth, getDate, subMonths } = require('date-fns');

// Función para enviar correos electrónicos de error a Cristian
const sendErrorEmail = async (error) => {
  const transporter = nodemailer.createTransport({
    SES: ses,
  });

  const params = {
    from: 'comunicaciones.sistemas@fastmoda.com.co 🇬🇹 Venta_Lili_Guatemala',
    to: ['comunicaciones.sistemas@fastmoda.com.co'],
    subject: 'Error en el Informe de Ventas Guatemala',
    html: `<p>Ha ocurrido un error al ejecutar el informe de ventas Guatemala:</p><p>${error.message}</p>`,
  };

  try {
    const info = await transporter.sendMail(params);
    console.log('Correo de error enviado exitosamente:', info);
  } catch (err) {
    console.log('Error al enviar el correo de error:', err);
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
      await new Promise(resolve => setTimeout(resolve, 1000)); // Espera 1 segundo antes de verificar nuevamente
    }

    const queryResults = await athena.getQueryResults({ QueryExecutionId: queryExecutionId }).promise();
    const columns = queryResults.ResultSet.ResultSetMetadata.ColumnInfo.map(column => column.Name);
    const rows = queryResults.ResultSet.Rows.slice(1); // Omitir la fila de encabezado
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

// Función para ejecutar la consulta SQL con fechas
const executeSQLQuery = async (startDate, endDate, isAccumulated = false) => {
  let iniDate, finDate, iniDatePastYear, finDatePastYear;

  if (isAccumulated) {
    iniDate = startOfMonth(startDate);
    finDate = endOfMonth(endDate);
    iniDatePastYear = startOfMonth(subYears(startDate, 1));
    finDatePastYear = endOfMonth(subYears(endDate, 1));
  } else {
    iniDate = startDate;
    finDate = endDate;
    iniDatePastYear = subYears(startDate, 1);
    finDatePastYear = subYears(endDate, 1);
  }

  // Mantener la lógica original de las fechas
  finDate = new Date(); // Fecha actual
  finDatePastYear = subYears(new Date(), 1); // Fecha actual del año pasado

  const query = `
      WITH last_tm AS (
          SELECT rate
          FROM odooguatemala.res_currency_rate
          WHERE currency_id = 2
            AND name <= DATE '${format(endDate, 'yyyy-MM-dd')}'
          ORDER BY name DESC
          LIMIT 1
      ),
      tm_query AS (
          SELECT 
              COALESCE(l.rate, 0) AS rate,
              ac.create_uid AS "IdUser"
          FROM odooguatemala.account_move_line ac
          LEFT JOIN odooguatemala.general_users tbl ON ac.create_uid = tbl.create_uid
          LEFT JOIN odooguatemala.res_currency rc ON ac.currency_id = rc.id
          CROSS JOIN last_tm l
          WHERE ac.account_id = 23 
              AND ac.date = DATE '${format(endDate, 'yyyy-MM-dd')}'
          GROUP BY ac.create_uid, COALESCE(l.rate, 0)
      )
      SELECT
          UPPER(
              CASE 
                  WHEN q."Stores" = 'Canal Moderno' OR q."Stores" = 'Carlos Secaida' THEN 'CANAL MODERNO'
                  ELSE COALESCE(q."Stores", q2."Stores")
              END
          ) AS "Stores",
          CAST(SUM(COALESCE(q."Dia 2024 (GTQ)", 0)) AS DECIMAL(15, 2)) AS "Dia 2024 (GTQ)",
          CAST(SUM(COALESCE(q."Unid 2024", 0)) AS DECIMAL(15, 2)) AS "Unid 2024",
          CAST(SUM(COALESCE(q2."Dia 2025 (GTQ)", 0)) AS DECIMAL(15, 2)) AS "Dia 2025 (GTQ)",
          CAST(SUM(COALESCE(q2."Unid 2025", 0)) AS DECIMAL(15, 2)) AS "Unid 2025",
          CAST(ROUND(SUM(CAST(ROUND(COALESCE(q."Dia 2024 (GTQ)", 0), 2) AS DECIMAL(18, 2)) * CAST(ROUND(COALESCE(tm.rate, l.rate), 4) AS DECIMAL(18, 4))), 2) AS DECIMAL(18, 2)) AS "Dia 2024 (USD)",
          CAST(ROUND(SUM(CAST(ROUND(COALESCE(q2."Dia 2025 (GTQ)", 0), 2) AS DECIMAL(18, 2)) * CAST(ROUND(COALESCE(tm.rate, l.rate), 4) AS DECIMAL(18, 4))), 2) AS DECIMAL(18, 2)) AS "Dia 2025 (USD)",
          CASE 
              WHEN SUM(COALESCE(q."Dia 2024 (GTQ)", 0)) = 0 THEN 100.00
              WHEN SUM(COALESCE(q2."Dia 2025 (GTQ)", 0)) = 0 THEN 0.00
              ELSE CAST(ROUND(((SUM(COALESCE(q2."Dia 2025 (GTQ)", 0)) / NULLIF(COALESCE(tm.rate, l.rate), 0)) - (SUM(COALESCE(q."Dia 2024 (GTQ)", 0)) / NULLIF(COALESCE(tm.rate, l.rate), 0))) / (SUM(COALESCE(q."Dia 2024 (GTQ)", 0)) / NULLIF(COALESCE(tm.rate, l.rate), 0)) * 100, 2) AS DECIMAL(15, 2))
          END AS "% Crec Vta (USD)",
          CASE 
              WHEN SUM(COALESCE(q."Unid 2024", 0)) = 0 THEN 100.00
              WHEN SUM(COALESCE(q2."Unid 2025", 0)) = 0 THEN 0.00
              ELSE CAST(ROUND(((SUM(COALESCE(q2."Unid 2025", 0)) / NULLIF(COALESCE(tm.rate, l.rate), 0)) - (SUM(COALESCE(q."Unid 2024", 0)) / NULLIF(COALESCE(tm.rate, l.rate), 0))) / (SUM(COALESCE(q."Unid 2024", 0)) / NULLIF(COALESCE(tm.rate, l.rate), 0)) * 100, 2) AS DECIMAL(15, 2))
          END AS "% Crec Unid"
      FROM
          (
              SELECT 
                  CASE 
                      WHEN tbl.name_large LIKE '%Canal Moderno%' THEN 'Canal Moderno'
                      ELSE tbl.name_large
                  END as "Stores",
                  po.create_uid AS "IdUser",
                  SUM(po.price_subtotal) as "Dia 2024 (GTQ)",
                  SUM(CASE 
                          WHEN pct.name LIKE 'Cupones'
                          OR pct.name LIKE 'PROMOCION'
                          OR pct.name LIKE 'CERTIFICADOS CLUB BI'
                          OR pct.name LIKE 'TARJETAS DE REGALO'
                          OR pct.name LIKE 'TARJETAS MERCADERO'
                          THEN 0 ELSE po.qty 
                      END) as "Unid 2024"
              FROM odooguatemala.pos_order_line po
              LEFT JOIN odooguatemala.pos_order pos ON po.order_id = pos.id
              LEFT JOIN odooguatemala.product_product pp ON po.product_id = pp.id
              LEFT JOIN odooguatemala.product_template pt ON pp.product_tmpl_id = pt.id
              LEFT JOIN odooguatemala.product_category pct ON pt.categ_id = pct.id
              LEFT JOIN odooguatemala.general_users tbl ON po.create_uid = tbl.create_uid
              WHERE pos."create_date" BETWEEN TIMESTAMP '${format(iniDatePastYear, 'yyyy-MM-dd')} 05:00:00' AND TIMESTAMP '${format(finDatePastYear, 'yyyy-MM-dd')} 04:59:59'
                  --AND po.full_product_name NOT LIKE '%CR-Puntos%'
                  AND pos.state = 'invoiced'
              GROUP BY 
                  CASE 
                      WHEN tbl.name_large LIKE '%Canal Moderno%' THEN 'Canal Moderno'
                      ELSE tbl.name_large
                  END,
                  po.create_uid
              UNION ALL
              SELECT 
                  CASE 
                      WHEN tbl.name_large LIKE '%Canal Moderno%' THEN 'Canal Moderno'
                      ELSE tbl.name_large
                  END as "Stores",
                  tbl.create_uid as "IdUser",
                  SUM(sol.price_subtotal) as "Dia 2024 (GTQ)",
                  SUM(CASE 
                            WHEN pct.name LIKE 'Cupones'
                            OR pct.name LIKE 'PROMOCION'
                            OR pct.name LIKE 'CERTIFICADOS CLUB BI'
                            OR pct.name LIKE 'TARJETAS DE REGALO'
                            OR pct.name LIKE 'TARJETAS MERCADERO'
                            THEN 0 ELSE sol.qty_invoiced 
                        END) AS "Unid 2024"
              FROM odooguatemala.sale_order_line sol
              LEFT JOIN odooguatemala.general_users tbl ON sol.create_uid = tbl.create_uid
              LEFT JOIN odooguatemala.product_product pp ON sol.product_id = pp.id
              LEFT JOIN odooguatemala.product_template pt ON pp.product_tmpl_id = pt.id
              LEFT JOIN odooguatemala.product_category pct ON pt.categ_id = pct.id
              WHERE sol."create_date" BETWEEN TIMESTAMP '${format(iniDatePastYear, 'yyyy-MM-dd')} 05:00:00' AND TIMESTAMP '${format(finDatePastYear, 'yyyy-MM-dd')} 04:59:59'
                  AND sol.invoice_status = 'invoiced'
                  --AND sol.name NOT LIKE '%CR-Puntos%'
              GROUP BY 
                  CASE 
                      WHEN tbl.name_large LIKE '%Canal Moderno%' THEN 'Canal Moderno'
                      ELSE tbl.name_large
                  END,
                  tbl.create_uid
          ) AS q
      FULL OUTER JOIN
          (
              SELECT 
                  CASE 
                      WHEN tbl.name_large LIKE '%Canal Moderno%' THEN 'Canal Moderno'
                      ELSE tbl.name_large
                  END as "Stores",
                  po.create_uid AS "IdUser",
                  SUM(po.price_subtotal) as "Dia 2025 (GTQ)",
                  SUM(CASE 
                            WHEN pct.name LIKE 'Cupones'
                            OR pct.name LIKE 'PROMOCION'
                            OR pct.name LIKE 'CERTIFICADOS CLUB BI'
                            OR pct.name LIKE 'TARJETAS DE REGALO'
                            OR pct.name LIKE 'TARJETAS MERCADERO'
                            THEN 0 ELSE po.qty 
                        END) as "Unid 2025"
              FROM odooguatemala.pos_order_line po
              LEFT JOIN odooguatemala.pos_order pos ON po.order_id = pos.id
              LEFT JOIN odooguatemala.product_product pp ON po.product_id = pp.id
              LEFT JOIN odooguatemala.product_template pt ON pp.product_tmpl_id = pt.id
              LEFT JOIN odooguatemala.product_category pct ON pt.categ_id = pct.id  
              LEFT JOIN odooguatemala.general_users tbl ON po.create_uid = tbl.create_uid
              WHERE pos."create_date" BETWEEN TIMESTAMP '${format(iniDate, 'yyyy-MM-dd')} 05:00:00' AND TIMESTAMP '${format(finDate, 'yyyy-MM-dd')} 04:59:59'
                  --AND po.full_product_name NOT LIKE '%CR-Puntos%'
                  AND pos.state = 'invoiced'
              GROUP BY 
                  CASE 
                      WHEN tbl.name_large LIKE '%Canal Moderno%' THEN 'Canal Moderno'
                      ELSE tbl.name_large
                  END,
                  po.create_uid    
              UNION ALL    
              SELECT 
                  CASE 
                      WHEN tbl.name_large LIKE '%Canal Moderno%' THEN 'Canal Moderno'
                      ELSE tbl.name_large
                  END as "Stores",
                  tbl.create_uid as "IdUser",
                  SUM(sol.price_subtotal) as "Dia 2025 (GTQ)",
                  SUM(CASE 
                            WHEN pct.name LIKE 'Cupones'
                            OR pct.name LIKE 'PROMOCION'
                            OR pct.name LIKE 'CERTIFICADOS CLUB BI'
                            OR pct.name LIKE 'TARJETAS DE REGALO'
                            OR pct.name LIKE 'TARJETAS MERCADERO'
                            THEN 0 ELSE sol.qty_invoiced 
                        END) AS "Unid 2025"
              FROM odooguatemala.sale_order_line sol
              LEFT JOIN odooguatemala.general_users tbl ON sol.create_uid = tbl.create_uid
              LEFT JOIN odooguatemala.product_product pp ON sol.product_id = pp.id
              LEFT JOIN odooguatemala.product_template pt ON pp.product_tmpl_id = pt.id
              LEFT JOIN odooguatemala.product_category pct ON pt.categ_id = pct.id
              WHERE sol."create_date" BETWEEN TIMESTAMP '${format(iniDate, 'yyyy-MM-dd')} 05:00:00' AND TIMESTAMP '${format(finDate, 'yyyy-MM-dd')} 04:59:59'
                  AND sol.invoice_status = 'invoiced'
                  --AND sol.name NOT LIKE '%CR-Puntos%'
              GROUP BY 
                  CASE 
                      WHEN tbl.name_large LIKE '%Canal Moderno%' THEN 'Canal Moderno'
                      ELSE tbl.name_large
                  END,
                  tbl.create_uid
          ) AS q2
      ON q."IdUser" = q2."IdUser"
      LEFT JOIN tm_query tm ON q."IdUser" = tm."IdUser"
      CROSS JOIN last_tm l
      GROUP BY
          UPPER(
              CASE 
                  WHEN q."Stores" = 'Canal Moderno' OR q."Stores" = 'Carlos Secaida' THEN 'CANAL MODERNO'
                  ELSE COALESCE(q."Stores", q2."Stores")
              END
          ),
          COALESCE(tm.rate, l.rate)
      ORDER BY "Dia 2025 (GTQ)" DESC;
  `;
  const result = await executeSQLMethod(query);

  // Verificación de resultados vacíos
  if (!result || result.length === 0) {
    throw new Error('La consulta SQL retornó resultados vacíos.');
  }

  // Obtener nombres de columnas
  const columns = ["#", "Stores", "Dia 2024 (GTQ)", "Unid 2024", "Dia 2025 (GTQ)", "Unid 2025", "Dia 2024 (USD)", "Dia 2025 (USD)", "% Crec Vta (USD)", "% Crec Unid"];

  const data = result.map((item, index) => {
    return { "#": index + 1, ...item };
  });

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

  // Ejecuta las consultas SQL
  let columnsAccumulated, dataAccumulated, columnsDaily, dataDaily;
  try {
    ({ columns: columnsAccumulated, data: dataAccumulated } = await executeSQLQuery(ini_month, primer_dia_mes_siguiente, true));
    ({ columns: columnsDaily, data: dataDaily } = await executeSQLQuery(yesterday, today, false));
  } catch (error) {
    throw error; // Propagar el error para que sea capturado en el bloque principal
  }

  // Verificación de resultados vacíos adicionales
  if (!dataAccumulated || dataAccumulated.length === 0 || !dataDaily || dataDaily.length === 0) {
    throw new Error('Una o más consultas SQL retornaron resultados vacíos.');
  }

  const filterCanalModerno = data => data.filter(item => item["Stores"] === "CANAL MODERNO")
    .map(item => ({ ...item, "Stores": "CANAL MODERNO" }));
  const filterOtherStores = data => data.filter(item => item["Stores"] !== "CANAL MODERNO");

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
      Stores: 'TOTAL',
      "Dia 2024 (GTQ)": 0,
      "Unid 2024": 0,
      "Dia 2025 (GTQ)": 0,
      "Unid 2025": 0,
      "Dia 2024 (USD)": 0,
      "Dia 2025 (USD)": 0,
      "% Crec Vta (USD)": 0,
      "% Crec Unid": 0,
    };

    data.forEach(item => {
      totals["Dia 2024 (GTQ)"] += parseFloat((parseFloat((item["Dia 2024 (GTQ)"] || "0").replace(',', '')) || 0).toFixed(2));
      totals["Unid 2024"] += parseInt((item["Unid 2024"] || "0").replace(/,/g, '')) || 0;
      totals["Dia 2025 (GTQ)"] += parseFloat((parseFloat((item["Dia 2025 (GTQ)"] || "0").replace(',', '')) || 0).toFixed(2));
      totals["Unid 2025"] += parseInt((item["Unid 2025"] || "0").replace(/,/g, '')) || 0;
      totals["Dia 2024 (USD)"] += parseFloat((parseFloat((item["Dia 2024 (USD)"] || "0").replace(',', '')) || 0).toFixed(2));
      totals["Dia 2025 (USD)"] += parseFloat((parseFloat((item["Dia 2025 (USD)"] || "0").replace(',', '')) || 0).toFixed(2));
      totals["% Crec Vta (USD)"] += parseFloat((parseFloat((item["% Crec Vta (USD)"] || "0").replace(',', '')) || 0).toFixed(2));
      totals["% Crec Unid"] += parseFloat((parseFloat((item["% Crec Unid"] || "0").replace(/,/g, '')) || 0).toFixed(2));
    });

    // Calcular promedio para tasas de crecimiento
    let numRecords = data.length;
    totals["% Crec Vta (USD)"] = (totals["% Crec Vta (USD)"] / numRecords).toFixed(2);
    totals["% Crec Unid"] = (totals["% Crec Unid"] / numRecords).toFixed(2);

    let html = '<div style="padding: 20px; border: 4px solid #D3D3E9; border-radius: 15px; text-align: left; width: fit-content;">';
    html += `<p style="background-color:#D8D8EB; padding: 10px 20px; color:#3D3D7A; width: fit-content; border-radius: 15px; font-weight:500; margin: 0 0 0 6px; text-align: center;">`;
    html += `<img src="${iconUrl}" style="width:20px; height:15px; margin-right: 10px; vertical-align: middle;">`;
    html += `${title} ${subDays(today, 1).toLocaleString('es-CO', { timeZone: 'America/Bogota', day: 'numeric', month: 'long' }).toUpperCase()}</p><br>`;
    html += '<table style="border-collapse:collapse; font-family: Arial; font-size: 12px; border-radius: 15px;"><thead><tr>';

    // Crear encabezados de la tabla
    html += '<th style="padding:10px;border:1px solid #000;background-color:#bfbfbf;color:#000000; font-size: 12px; text-align: center;">#</th>';
    html += '<th style="padding:10px;border:1px solid #000;background-color:#bfbfbf;color:#000000; font-size: 12px; text-align: center;">Store</th>';
    html += '<th style="padding:10px;border:1px solid #000;background-color:#f1e5b5;color:#000000; font-size: 12px; text-align: center;">Dia 2024 (GTQ)</th>';
    html += '<th style="padding:10px;border:1px solid #000;background-color:#f1e5b5;color:#000000; font-size: 12px; text-align: center;">Unid 2024</th>';
    html += '<th style="padding:10px;border:1px solid #000;background-color:#b5c1f1;color:#000000; font-size: 12px; text-align: center;">Dia 2025 (GTQ)</th>';
    html += '<th style="padding:10px;border:1px solid #000;background-color:#b5c1f1;color:#000000; font-size: 12px; text-align: center;">Unid 2025</th>';
    html += '<th style="padding:10px;border:1px solid #000;background-color:#f1c8b5;color:#000000; font-size: 12px; text-align: center;">Dia 2024 (USD)</th>';
    html += '<th style="padding:10px;border:1px solid #000;background-color:#f1c8b5;color:#000000; font-size: 12px; text-align: center;">Dia 2025 (USD)</th>';
    html += '<th style="padding:10px;border:1px solid #000;background-color:#b5f1e5;color:#000000; font-size: 12px; text-align: center;">% Crec Vta (USD)</th>';
    html += '<th style="padding:10px;border:1px solid #000;background-color:#b5f1e5;color:#000000; font-size: 12px; text-align: center;">% Crec Unid</th>';
    html += '</tr></thead><tbody>';

    // Crear filas de la tabla
    data.forEach((item, index) => {
      let backgroundColor = index % 2 === 0 ? '#F9F9FC' : '#EDEDF5';
      html += `<tr style="background-color: ${backgroundColor};">`;

      html += `<td style="padding:10px;border:1px solid #000;color:#000; background-color:#f2f2f2; font-weight:300; text-align: left;">${item["#"] || ''}</td>`;
      html += `<td style="padding:10px;border:1px solid #000;color:#000; background-color:#f2f2f2; font-weight:300; text-align: left;">${item["Stores"] || ''}</td>`;
      html += `<td style="padding:10px;border:1px solid #000;color:#000; background-color:#f9f4e0; font-weight:300; text-align: right;">${Number(item["Dia 2024 (GTQ)"] || 0).toLocaleString()}</td>`;
      html += `<td style="padding:10px;border:1px solid #000;color:#000; background-color:#f9f4e0; font-weight:300; text-align: right;">${Number(item["Unid 2024"] || 0).toLocaleString()}</td>`;
      html += `<td style="padding:10px;border:1px solid #000;color:#000; background-color:#e0e5f9; font-weight:300; text-align: right;">${Number(item["Dia 2025 (GTQ)"] || 0).toLocaleString()}</td>`;
      html += `<td style="padding:10px;border:1px solid #000;color:#000; background-color:#e0e5f9; font-weight:300; text-align: right;">${Number(item["Unid 2025"] || 0).toLocaleString()}</td>`;
      html += `<td style="padding:10px;border:1px solid #000;color:#000; background-color:#f9e8e0; font-weight:300; text-align: right;">${Number(item["Dia 2024 (USD)"] || 0).toLocaleString()}</td>`;
      html += `<td style="padding:10px;border:1px solid #000;color:#000; background-color:#f9e8e0; font-weight:300; text-align: right;">${Number(item["Dia 2025 (USD)"] || 0).toLocaleString()}</td>`;
      html += `<td style="padding:10px;border:1px solid #000;color:#000; background-color:#e0f9f4; font-weight:300; text-align: right;">${Number(item["% Crec Vta (USD)"] || 0).toLocaleString()}%</td>`;
      html += `<td style="padding:10px;border:1px solid #000;color:#000; background-color:#e0f9f4; font-weight:300; text-align: right;">${Number(item["% Crec Unid"] || 0).toLocaleString()}%</td>`;
      html += '</tr>';
    });

    // Añadir fila de totales
    html += '<tr style="background-color: #bfbfbf; font-weight: bold;">';
    html += `<td style="padding:10px;border:1px solid #000;color:#000; text-align: left;">${totals["#"]}</td>`;
    html += `<td style="padding:10px;border:1px solid #000;color:#000; text-align: left;">${totals["Stores"]}</td>`;
    html += `<td style="padding:10px;border:1px solid #000;color:#000; text-align: right;">${parseFloat(totals["Dia 2024 (GTQ)"]).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>`;
    html += `<td style="padding:10px;border:1px solid #000;color:#000; text-align: right;">${parseInt(totals["Unid 2024"]).toLocaleString()}</td>`;
    html += `<td style="padding:10px;border:1px solid #000;color:#000; text-align: right;">${parseFloat(totals["Dia 2025 (GTQ)"]).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>`;
    html += `<td style="padding:10px;border:1px solid #000;color:#000; text-align: right;">${parseInt(totals["Unid 2025"]).toLocaleString()}</td>`;
    html += `<td style="padding:10px;border:1px solid #000;color:#000; text-align: right;">${parseFloat(totals["Dia 2024 (USD)"]).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>`;
    html += `<td style="padding:10px;border:1px solid #000;color:#000; text-align: right;">${parseFloat(totals["Dia 2025 (USD)"]).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>`;
    html += `<td style="padding:10px;border:1px solid #000;color:#000; text-align: right;">${parseFloat(totals["% Crec Vta (USD)"]).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%</td>`;
    html += `<td style="padding:10px;border:1px solid #000;color:#000; text-align: right;">${parseFloat(totals["% Crec Unid"]).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%</td>`;
    html += '</tr>';

    html += '</tbody></table></div>';
    return html;
  }

  // Función para crear la tabla de totales HTML
  function createTotalHTMLTable(totals, title, iconUrl) {
    let html = '<div style="padding: 20px; border: 4px solid #D3D3E9; border-radius: 15px; text-align: left; width: fit-content;">';
    html += `<p style="background-color:#D8D8EB; padding: 10px 20px; color:#3D3D7A; width: fit-content; border-radius: 15px; font-weight:500; margin: 0 0 0 6px; text-align: center;">`;
    html += `<img src="${iconUrl}" style="width:20px; height:15px; margin-right: 10px; vertical-align: middle;">`;
    html += `${title} ${subDays(today, 1).toLocaleString('es-CO', { timeZone: 'America/Bogota', day: 'numeric', month: 'long' }).toUpperCase()}</p><br>`;
    html += '<table style="border-collapse:collapse; font-family: Arial; font-size: 12px; border-radius: 15px;"><thead><tr>';

    // Crear encabezados de la tabla
    html += '<th style="padding:10px;border:1px solid #000;background-color:#bfbfbf;color:#000000; font-size: 12px; text-align: center;">#</th>';
    html += '<th style="padding:10px;border:1px solid #000;background-color:#bfbfbf;color:#000000; font-size: 12px; text-align: center;">Store</th>';
    html += '<th style="padding:10px;border:1px solid #000;background-color:#f1e5b5;color:#000000; font-size: 12px; text-align: center;">Dia 2024 (GTQ)</th>';
    html += '<th style="padding:10px;border:1px solid #000;background-color:#f1e5b5;color:#000000; font-size: 12px; text-align: center;">Unid 2024</th>';
    html += '<th style="padding:10px;border:1px solid #000;background-color:#b5c1f1;color:#000000; font-size: 12px; text-align: center;">Dia 2025 (GTQ)</th>';
    html += '<th style="padding:10px;border:1px solid #000;background-color:#b5c1f1;color:#000000; font-size: 12px; text-align: center;">Unid 2025</th>';
    html += '<th style="padding:10px;border:1px solid #000;background-color:#f1c8b5;color:#000000; font-size: 12px; text-align: center;">Dia 2024 (USD)</th>';
    html += '<th style="padding:10px;border:1px solid #000;background-color:#f1c8b5;color:#000000; font-size: 12px; text-align: center;">Dia 2025 (USD)</th>';
    html += '<th style="padding:10px;border:1px solid #000;background-color:#b5f1e5;color:#000000; font-size: 12px; text-align: center;">% Crec Vta (USD)</th>';
    html += '<th style="padding:10px;border:1px solid #000;background-color:#b5f1e5;color:#000000; font-size: 12px; text-align: center;">% Crec Unid</th>';
    html += '</tr></thead><tbody>';

    // Añadir fila de totales
    html += '<tr style="background-color: #bfbfbf; font-weight: bold;">';
    html += `<td style="padding:10px;border:1px solid #000;color:#000; text-align: left;">${totals["#"]}</td>`;
    html += `<td style="padding:10px;border:1px solid #000;color:#000; text-align: left;">${totals["Stores"]}</td>`;
    html += `<td style="padding:10px;border:1px solid #000;color:#000; text-align: right;">${parseFloat(totals["Dia 2024 (GTQ)"]).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>`;
    html += `<td style="padding:10px;border:1px solid #000;color:#000; text-align: right;">${parseInt(totals["Unid 2024"]).toLocaleString()}</td>`;
    html += `<td style="padding:10px;border:1px solid #000;color:#000; text-align: right;">${parseFloat(totals["Dia 2025 (GTQ)"]).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>`;
    html += `<td style="padding:10px;border:1px solid #000;color:#000; text-align: right;">${parseInt(totals["Unid 2025"]).toLocaleString()}</td>`;
    html += `<td style="padding:10px;border:1px solid #000;color:#000; text-align: right;">${parseFloat(totals["Dia 2024 (USD)"]).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>`;
    html += `<td style="padding:10px;border:1px solid #000;color:#000; text-align: right;">${parseFloat(totals["Dia 2025 (USD)"]).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>`;
    html += `<td style="padding:10px;border:1px solid #000;color:#000; text-align: right;">${parseFloat(totals["% Crec Vta (USD)"]).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%</td>`;
    html += `<td style="padding:10px;border:1px solid #000;color:#000; text-align: right;">${parseFloat(totals["% Crec Unid"]).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%</td>`;
    html += '</tr>';

    html += '</tbody></table></div>';
    return html;
  }

  // Calcular totales para datos acumulados
  const totalAccumulatedHtml = createTotalHTMLTable({
    "#": '',
    Stores: 'TOTAL',
    "Dia 2024 (GTQ)": dataAccumulated.reduce((acc, item) => acc + parseFloat(item["Dia 2024 (GTQ)"] || 0), 0).toFixed(2),
    "Unid 2024": dataAccumulated.reduce((acc, item) => acc + parseInt(item["Unid 2024"] || 0), 0).toFixed(0),
    "Dia 2025 (GTQ)": dataAccumulated.reduce((acc, item) => acc + parseFloat(item["Dia 2025 (GTQ)"] || 0), 0).toFixed(2),
    "Unid 2025": dataAccumulated.reduce((acc, item) => acc + parseInt(item["Unid 2025"] || 0), 0).toFixed(0),
    "Dia 2024 (USD)": dataAccumulated.reduce((acc, item) => acc + parseFloat(item["Dia 2024 (USD)"] || 0), 0).toFixed(2),
    "Dia 2025 (USD)": dataAccumulated.reduce((acc, item) => acc + parseFloat(item["Dia 2025 (USD)"] || 0), 0).toFixed(2),
    "% Crec Vta (USD)": (dataAccumulated.reduce((acc, item) => acc + parseFloat(item["% Crec Vta (USD)"] || 0), 0) / dataAccumulated.length).toFixed(2) + '%',
    "% Crec Unid": (dataAccumulated.reduce((acc, item) => acc + parseFloat(item["% Crec Unid"] || 0), 0) / dataAccumulated.length).toFixed(2) + '%',
  }, `TOTAL ACUMULADO`, 'https://upload.wikimedia.org/wikipedia/commons/thumb/e/ec/Flag_of_Guatemala.svg/1920px-Flag_of_Guatemala.svg.png');

  // Calcular totales para datos diarios
  const totalDailyHtml = createTotalHTMLTable({
    "#": '',
    Stores: 'TOTAL',
    "Dia 2024 (GTQ)": dataDaily.reduce((acc, item) => acc + parseFloat(item["Dia 2024 (GTQ)"] || 0), 0).toFixed(2),
    "Unid 2024": dataDaily.reduce((acc, item) => acc + parseInt(item["Unid 2024"] || 0), 0).toFixed(0),
    "Dia 2025 (GTQ)": dataDaily.reduce((acc, item) => acc + parseFloat(item["Dia 2025 (GTQ)"] || 0), 0).toFixed(2),
    "Unid 2025": dataDaily.reduce((acc, item) => acc + parseInt(item["Unid 2025"] || 0), 0).toFixed(0),
    "Dia 2024 (USD)": dataDaily.reduce((acc, item) => acc + parseFloat(item["Dia 2024 (USD)"] || 0), 0).toFixed(2),
    "Dia 2025 (USD)": dataDaily.reduce((acc, item) => acc + parseFloat(item["Dia 2025 (USD)"] || 0), 0).toFixed(2),
    "% Crec Vta (USD)": (dataDaily.reduce((acc, item) => acc + parseFloat(item["% Crec Vta (USD)"] || 0), 0) / dataDaily.length).toFixed(2) + '%',
    "% Crec Unid": (dataDaily.reduce((acc, item) => acc + parseFloat(item["% Crec Unid"] || 0), 0) / dataDaily.length).toFixed(2) + '%',
  }, `TOTAL FECHA A FECHA`, 'https://upload.wikimedia.org/wikipedia/commons/thumb/e/ec/Flag_of_Guatemala.svg/1920px-Flag_of_Guatemala.svg.png');

  // Crear las tablas HTML individuales
  const accumulatedHtml = createHTMLTable(columnsAccumulated, reindexedAccumulatedOtherStores, `INFORME ACUMULADO DEL ${format(ini_month, 'd').toUpperCase()} AL `, 'https://upload.wikimedia.org/wikipedia/commons/thumb/e/ec/Flag_of_Guatemala.svg/1920px-Flag_of_Guatemala.svg.png');
  const dailyHtml = createHTMLTable(columnsDaily, reindexedDailyOtherStores, `INFORME FECHA A FECHA`, 'https://upload.wikimedia.org/wikipedia/commons/thumb/e/ec/Flag_of_Guatemala.svg/1920px-Flag_of_Guatemala.svg.png');

  const canalModernoHtmlAccumulated = createHTMLTable(columnsAccumulated, reindexedAccumulatedCanalModerno, `CANAL MODERNO ACUMULADO`, 'https://upload.wikimedia.org/wikipedia/commons/thumb/e/ec/Flag_of_Guatemala.svg/1920px-Flag_of_Guatemala.svg.png');
  const canalModernoHtmlDaily = createHTMLTable(columnsDaily, reindexedDailyCanalModerno, `CANAL MODERNO FECHA A FECHA`, 'https://upload.wikimedia.org/wikipedia/commons/thumb/e/ec/Flag_of_Guatemala.svg/1920px-Flag_of_Guatemala.svg.png');

  // Concatenar todas las tablas en el contenido final del email
  const html = dailyHtml + '<br><br>' + canalModernoHtmlDaily + '<br><br>' + totalDailyHtml + '<br><br>' + accumulatedHtml + '<br><br>' + canalModernoHtmlAccumulated + '<br><br>' + totalAccumulatedHtml;

  return {
    html
  };
};

// Función para enviar el correo electrónico principal
const emailgtd = async (html) => {
  const transporter = nodemailer.createTransport({
    SES: ses,
  });

  const params = {
    from: 'comunicaciones.sistemas@fastmoda.com.co 🇬🇹 Venta_Lili_Guatemala',
    to: ['yeimy.jimenez@fastmoda.com.co',
      'kevin.castillo@fastmoda.com.co',
      'andres.hernandez@fastmoda.com.co',
      'marcela.montenegro@lilipink.hn',
      'daniela.velasquez@lilipink.hn',
      'karla.palacios@fastmoda.com.co',
      'nassim@dvpty.com',
      'david@lilipink.com'],
    subject: 'Informe de ventas Guatemala',
    html: html,
  };

  try {
    const info = await transporter.sendMail(params);
    console.log('Email enviado exitosamente:', info);
  } catch (error) {
    console.log('Error al enviar el email:', error);
    throw error; // Re-lanzar el error para que pueda ser capturado en el bloque principal
  }
};

// Función exportada que maneja el envío de correos
exports.emailgtd = async () => {
  try {
    const { html } = await tableEmailAccumulated();
    await emailgtd(html);
    console.log("Correo enviado correctamente.");
  } catch (error) {
    console.error("Error al procesar el correo:", error);
    await sendErrorEmail(error);
    console.log("Correo de error enviado ");
  }
};
