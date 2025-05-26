'use strict';
const { athena, ses } = require('../configurations/awsSetting');
const nodemailer = require('nodemailer');
  // Asegúrate de instalar node-fetch
const { format, subDays, startOfMonth, addMonths, subYears, endOfMonth, getDate, subMonths } = require('date-fns');
const { es } = require('date-fns/locale');

// Función para enviar correos electrónicos de error a Cristian
const sendErrorEmail = async (error) => {
  const transporter = nodemailer.createTransport({
    SES: ses,
  });

  const params = {
    from: 'comunicaciones.sistemas@fastmoda.com.co 🇵🇦 Venta_Lili_Panama',
    to: ['yeimy.jimenez@fastmoda.com.co'], // Puedes agregar más destinatarios si lo deseas
    subject: 'Error en el Informe de Ventas Panamá',
    html: `<p>Ha ocurrido un error al ejecutar el informe de ventas Panamá:</p><p>${error.message}</p>`,
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

  finDate = new Date(); // Set to current date
  finDatePastYear = subDays(subYears(new Date(), 1), 1); // Set to current date of last year

  const query = `
      WITH Ventas2025 AS (
          SELECT
              T6."col1" AS "name",
              COUNT(DISTINCT T1."ProfitCode") AS Store,
              T1."ProfitCode" AS "CentroBeneficio",
              SUM(CASE 
                  WHEN T0."TransType" <> '30' THEN 
                      ((COALESCE(I1."LineTotal", 0) - COALESCE(R1."LineTotal", 0)) - COALESCE(T3."Descuento", 0)) 
                  ELSE 
                      ((T1."Debit" * -1) - (T1."Credit" * -1)) 
              END) AS "sales",
              (SUM((COALESCE(R1."Quantity", 0) - COALESCE(I1."Quantity", 0))) * -1) AS "sold_units"
          FROM "sap-b1-nat-corp-pa".OJDT T0
              INNER JOIN "sap-b1-nat-corp-pa".JDT1 T1 ON T0."TransId" = T1."TransId"
              LEFT JOIN "sap-b1-nat-corp-pa".OINV OI ON T0."TransType" = OI."ObjType" AND T0."CreatedBy" = OI."DocEntry"
              LEFT JOIN "sap-b1-nat-corp-pa".INV1 I1 ON OI."DocEntry" = I1."DocEntry" AND T1."Account" = I1."AcctCode"
              LEFT JOIN "sap-b1-nat-corp-pa".ORIN T2 ON T0."TransType" = T2."ObjType" AND T0."CreatedBy" = T2."DocEntry"
              LEFT JOIN "sap-b1-nat-corp-pa".RIN1 R1 ON T2."DocEntry" = R1."DocEntry" AND T1."Account" = R1."AcctCode"
              LEFT  JOIN "sap-b1-nat-corp-pa"."business_units" T6 ON T1."ProfitCode" = T6."col2"
              LEFT JOIN (
                  SELECT T0."DocEntry", (T0."DiscSum" / (T1."VisOrder" + 1)) AS "Descuento"
                  FROM "sap-b1-nat-corp-pa".OINV T0
                      INNER JOIN (SELECT "DocEntry", MAX("VisOrder") AS "VisOrder"
                                  FROM "sap-b1-nat-corp-pa".INV1
                                  GROUP BY "DocEntry") T1 ON T0."DocEntry" = T1."DocEntry"
                  WHERE "DiscSum" <> 0
                  UNION ALL
                  SELECT T0."DocEntry", (T0."DiscSum" / (T1."VisOrder" + 1 )) * -1 AS "Descuento"
                  FROM "sap-b1-nat-corp-pa".ORIN T0
                      INNER JOIN (SELECT "DocEntry", MAX("VisOrder") AS "VisOrder"
                                  FROM "sap-b1-nat-corp-pa".RIN1
                                  GROUP BY "DocEntry") T1 ON T0."DocEntry" = T1."DocEntry"
                  WHERE "DiscSum" <> 0
              ) T3 ON T0."CreatedBy" = T3."DocEntry"
          WHERE T0."RefDate" BETWEEN TIMESTAMP '${format(iniDate, 'yyyy-MM-dd')}' AND TIMESTAMP '${format(finDate, 'yyyy-MM-dd')}'
              AND T1."Account" IN ('401001','401009', '401010', '401011')
          GROUP BY T6."col1", T1."ProfitCode"
      ), Ventas2024 AS (
          SELECT
              T6."col1" AS "name",
              T1."ProfitCode" AS "CentroBeneficio",
              SUM(CASE 
                  WHEN T0."TransType" <> '30' THEN 
                      ((COALESCE(I1."LineTotal", 0) - COALESCE(R1."LineTotal", 0)) - COALESCE(T3."Descuento", 0)) 
                  ELSE 
                      ((T1."Debit" * -1) - (T1."Credit" * -1)) 
              END) AS "sales_ly",
              (SUM((COALESCE(R1."Quantity", 0) - COALESCE(I1."Quantity", 0))) * -1) AS "sold_units_ly"
          FROM "sap-b1-nat-corp-pa".OJDT T0
              INNER JOIN "sap-b1-nat-corp-pa".JDT1 T1 ON T0."TransId" = T1."TransId"
              LEFT JOIN "sap-b1-nat-corp-pa".OINV OI ON T0."TransType" = OI."ObjType" AND T0."CreatedBy" = OI."DocEntry"
              LEFT JOIN "sap-b1-nat-corp-pa".INV1 I1 ON OI."DocEntry" = I1."DocEntry" AND T1."Account" = I1."AcctCode"
              LEFT JOIN "sap-b1-nat-corp-pa".ORIN T2 ON T0."TransType" = T2."ObjType" AND T0."CreatedBy" = T2."DocEntry"
              LEFT JOIN "sap-b1-nat-corp-pa".RIN1 R1 ON T2."DocEntry" = R1."DocEntry" AND T1."Account" = R1."AcctCode"
              LEFT  JOIN "sap-b1-nat-corp-pa"."business_units" T6 ON T1."ProfitCode" = T6."col2"
              LEFT JOIN (
                  SELECT T0."DocEntry", (T0."DiscSum" / (T1."VisOrder" + 1)) AS "Descuento"
                  FROM "sap-b1-nat-corp-pa".OINV T0
                      INNER JOIN (SELECT "DocEntry", MAX("VisOrder") AS "VisOrder"
                                  FROM "sap-b1-nat-corp-pa".INV1
                                  GROUP BY "DocEntry") T1 ON T0."DocEntry" = T1."DocEntry"
                  WHERE "DiscSum" <> 0
                  UNION ALL
                  SELECT T0."DocEntry", (T0."DiscSum" / (T1."VisOrder" + 1 )) * -1 AS "Descuento"
                  FROM "sap-b1-nat-corp-pa".ORIN T0
                      INNER JOIN (SELECT "DocEntry", MAX("VisOrder") AS "VisOrder"
                                  FROM "sap-b1-nat-corp-pa".RIN1
                                  GROUP BY "DocEntry") T1 ON T0."DocEntry" = T1."DocEntry"
                  WHERE "DiscSum" <> 0
              ) T3 ON T0."CreatedBy" = T3."DocEntry"
          WHERE T0."RefDate" BETWEEN TIMESTAMP '${format(iniDatePastYear, 'yyyy-MM-dd')}' AND TIMESTAMP '${format(finDatePastYear, 'yyyy-MM-dd')}'
              AND T1."Account" IN ('401001','401009', '401010', '401011')
          GROUP BY T6."col1", T1."ProfitCode"
      )
      SELECT
          CASE
              WHEN V2025."CentroBeneficio" IN ('02', '01') THEN 'CANAL MODERNO'
              ELSE COALESCE(V2025."name", 'CANAL MODERNO')
          END AS "Stores",
          COALESCE(SUM(V2024."sales_ly"), 0) AS "Dia 2024 (USD)",
          COALESCE(SUM(V2024."sold_units_ly"), 0) AS "Unid 2024",
          COALESCE(SUM(V2025."sales"), 0) AS "Dia 2025 (USD)",
          COALESCE(SUM(V2025."sold_units"), 0) AS "Unid 2025",
          IF(COALESCE(SUM(V2024."sales_ly"), 0) = 0, 100, ROUND(((CAST(SUM(V2025."sales") AS DOUBLE) / CAST(SUM(V2024."sales_ly") AS DOUBLE)) - 1) * 100, 2)) AS "% Crec Vta",
          IF(COALESCE(SUM(V2024."sold_units_ly"), 0) = 0, 100, ROUND(((CAST(SUM(V2025."sold_units") AS DOUBLE) / CAST(SUM(V2024."sold_units_ly") AS DOUBLE))  - 1) * 100, 2)) AS "% Crec Unid"
      FROM
          Ventas2024 V2024
      FULL OUTER JOIN Ventas2025 V2025 
          ON V2024."name" = V2025."name" AND V2024."CentroBeneficio" = V2025."CentroBeneficio"
      GROUP BY
          CASE
              WHEN V2025."CentroBeneficio" IN ('02', '01') THEN 'CANAL MODERNO'
              ELSE COALESCE(V2025."name", 'CANAL MODERNO')
          END
      ORDER BY
          "Stores";
  `; 
  const result = await executeSQLMethod(query);

  // Get column names
  const columns = ["#", "Stores", "Dia 2024 (USD)", "Unid 2024", "Dia 2025 (USD)", "Unid 2025", "% Crec Vta", "% Crec Unid"];

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
    ({ columns: columnsAccumulated, data: dataAccumulated } = await executeSQLQuery(ini_month, primer_dia_mes_siguiente, true));
    ({ columns: columnsDaily, data: dataDaily } = await executeSQLQuery(yesterday, today, false));
  } catch (error) {
    throw error; // Propagar el error para que sea capturado en el bloque principal
  }

  // Filtrado de datos para "CANAL MODERNO" y otros stores
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
      "Dia 2024 (USD)": 0,
      "Unid 2024": 0,
      "Dia 2025 (USD)": 0,
      "Unid 2025": 0,
      "% Crec Vta": 0,
      "% Crec Unid": 0,
    };

    data.forEach(item => {
      totals["Dia 2024 (USD)"] += parseFloat((parseFloat((item["Dia 2024 (USD)"] || "0").replace(',', '')) || 0).toFixed(2));
      totals["Unid 2024"] += parseInt((item["Unid 2024"] || "0").replace(/,/g, '')) || 0;
      totals["Dia 2025 (USD)"] += parseFloat((parseFloat((item["Dia 2025 (USD)"] || "0").replace(',', '')) || 0).toFixed(2));
      totals["Unid 2025"] += parseInt((item["Unid 2025"] || "0").replace(/,/g, '')) || 0;
    });

    // Calcular tasas de crecimiento
    totals["% Crec Vta"] = (
      (totals["Dia 2025 (USD)"] - totals["Dia 2024 (USD)"]) /
      (totals["Dia 2024 (USD)"] || 1) * 100
    ).toFixed(2) + '%';

    totals["% Crec Unid"] = (
      (totals["Unid 2025"] - totals["Unid 2024"]) /
      (totals["Unid 2024"] || 1) * 100
    ).toFixed(2) + '%';

    let html = '<div style="padding: 20px; border: 4px solid #D3D3E9; border-radius: 15px; text-align: left; width: fit-content;">';
    html += `<p style="background-color:#D8D8EB; padding: 10px 20px; color: #3D3D7A; width: fit-content; border-radius: 15px; font-weight:500; margin: 0 0 0 6px; text-align: center;">`;
    html += `<img src="${iconUrl}" style="width:20px; height:15px; margin-right: 10px; vertical-align: middle;">`;
    html += `${title} ${subDays(today, 1).toLocaleString('es-CO', { timeZone: 'America/Bogota', day: 'numeric', month: 'long' }).toUpperCase()}</p><br>`;
    html += '<table style="border-collapse:collapse; font-family: Arial; font-size: 12px; border-radius: 15px;"><thead><tr>';

    // Crear encabezados de la tabla
    html += '<th style="padding:10px;border:1px solid #000;background-color:#bfbfbf;color:#000000; font-size: 12px; text-align: center; width: fit-content; margin: 0 auto;">#</th>';
    html += '<th style="padding:10px;border:1px solid #000;background-color:#bfbfbf;color:#000000; font-size: 12px; text-align: center; width: fit-content; margin: 0 auto;">Store</th>';
    html += '<th style="padding:10px;border:1px solid #000;background-color:#C81020;color:#ffffff; font-size: 12px; text-align: center; width: fit-content; margin: 0 auto; max-width: 60px;">Dia 2024 (USD)</th>';
    html += '<th style="padding:10px;border:1px solid #000;background-color:#C81020;color:#ffffff; font-size: 12px; text-align: center; width: fit-content; margin: 0 auto; max-width: 60px;">Unid 2024</th>';
    html += '<th style="padding:10px;border:1px solid #000;background-color:#002878;color:#ffffff; font-size: 12px; text-align: center; width: fit-content; margin: 0 auto; max-width: 60px;">Dia 2025 (USD)</th>';
    html += '<th style="padding:10px;border:1px solid #000;background-color:#002878;color:#ffffff; font-size: 12px; text-align: center; width: fit-content; margin: 0 auto; max-width: 60px;">Unid 2025</th>';
    html += '<th style="padding:10px;border:1px solid #000;background-color:#ECECEC;color:#000000; font-size: 12px; text-align: center; width: fit-content; margin: 0 auto; max-width: 60px;">% Crec Vta</th>';
    html += '<th style="padding:10px;border:1px solid #000;background-color:#ECECEC;color:#000000; font-size: 12px; text-align: center; width: fit-content; margin: 0 auto; max-width: 60px;">% Crec Unid</th>';
    html += '</tr></thead><tbody>';

    // Crear filas de la tabla
    data.forEach((item, index) => {
      let backgroundColor = index % 2 === 0 ? '#F9F9FC' : '#EDEDF5';
      html += `<tr style="background-color: ${backgroundColor};">`;

      html += `<td style="padding:10px;border:1px solid #000;color:#000; background-color:#F9F9FC; font-weight:300; text-align: left;">${item["#"] || ''}</td>`;
      html += `<td style="padding:10px;border:1px solid #000;color:#000; background-color:#F9F9FC; font-weight:300; text-align: left;">${item["Stores"] || ''}</td>`;
      html += `<td style="padding:10px;border:1px solid #000;color:#000; background-color:#FFE5E7; font-weight:300; text-align: right;">${Number(item["Dia 2024 (USD)"] || 0).toLocaleString()}</td>`;
      html += `<td style="padding:10px;border:1px solid #000;color:#000; background-color:#FFE5E7; font-weight:300; text-align: right;">${Number(item["Unid 2024"] || 0).toLocaleString()}</td>`;
      html += `<td style="padding:10px;border:1px solid #000;color:#000; background-color:#E5EBFF; font-weight:300; text-align: right;">${Number(item["Dia 2025 (USD)"] || 0).toLocaleString()}</td>`;
      html += `<td style="padding:10px;border:1px solid #000;color:#000; background-color:#E5EBFF; font-weight:300; text-align: right;">${Number(item["Unid 2025"] || 0).toLocaleString()}</td>`;
      html += `<td style="padding:10px;border:1px solid #000;color:#000; background-color:#FDFDFD; font-weight:300; text-align: right;">${Number(item["% Crec Vta"] || 0).toLocaleString()}%</td>`;
      html += `<td style="padding:10px;border:1px solid #000;color:#000; background-color:#FDFDFD; font-weight:300; text-align: right;">${Number(item["% Crec Unid"] || 0).toLocaleString()}%</td>`;

      html += '</tr>';
    });

    // Añadir fila de totales
    html += '<tr style="background-color: #bfbfbf; font-weight: bold;">';
    html += `<td style="padding:10px;border:1px solid #000;color:#000; text-align: left;">${totals["#"]}</td>`;
    html += `<td style="padding:10px;border:1px solid #000;color:#000; text-align: left;">${totals["Stores"]}</td>`;
    html += `<td style="padding:10px;border:1px solid #000;color:#000; text-align: right;">${parseFloat(totals["Dia 2024 (USD)"]).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>`;
    html += `<td style="padding:10px;border:1px solid #000;color:#000; text-align: right;">${parseInt(totals["Unid 2024"]).toLocaleString()}</td>`;
    html += `<td style="padding:10px;border:1px solid #000;color:#000; text-align: right;">${parseFloat(totals["Dia 2025 (USD)"]).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>`;
    html += `<td style="padding:10px;border:1px solid #000;color:#000; text-align: right;">${parseInt(totals["Unid 2025"]).toLocaleString()}</td>`;
    html += `<td style="padding:10px;border:1px solid #000;color:#000; text-align: right;">${totals["% Crec Vta"]}</td>`;
    html += `<td style="padding:10px;border:1px solid #000;color:#000; text-align: right;">${totals["% Crec Unid"]}</td>`;
    html += '</tr>';

    html += '</tbody></table></div>';
    return html;
  }

  function createTotalHTMLTable(totals, title, iconUrl) {
    let html = '<div style="padding: 20px; border: 4px solid #D3D3E9; border-radius: 15px; text-align: left; width: fit-content;">';
    html += `<p style="background-color:#D8D8EB; padding: 10px 20px; color: #3D3D7A; width: fit-content; border-radius: 15px; font-weight:500; margin: 0 0 0 6px; text-align: center;">`;
    html += `<img src="${iconUrl}" style="width:20px; height:15px; margin-right: 10px; vertical-align: middle;">`;
    html += `${title} ${subDays(today, 1).toLocaleString('es-CO', { timeZone: 'America/Bogota', day: 'numeric', month: 'long' }).toUpperCase()}</p><br>`;
    html += '<table style="border-collapse:collapse; font-family: Arial; font-size: 12px; border-radius: 15px;"><thead><tr>';
  
    // Crear encabezados de la tabla
    html += '<th style="padding:10px;border:1px solid #000;background-color:#bfbfbf;color:#000000; font-size: 12px; text-align: center; width: fit-content; margin: 0 auto;">#</th>';
    html += '<th style="padding:10px;border:1px solid #000;background-color:#bfbfbf;color:#000000; font-size: 12px; text-align: center; width: fit-content; margin: 0 auto;">Store</th>';
    html += '<th style="padding:10px;border:1px solid #000;background-color:#C81020;color:#ffffff; font-size: 12px; text-align: center; width: fit-content; margin: 0 auto; max-width: 60px;">Dia 2024 (USD)</th>';
    html += '<th style="padding:10px;border:1px solid #000;background-color:#C81020;color:#ffffff; font-size: 12px; text-align: center; width: fit-content; margin: 0 auto; max-width: 60px;">Unid 2024</th>';
    html += '<th style="padding:10px;border:1px solid #000;background-color:#002878;color:#ffffff; font-size: 12px; text-align: center; width: fit-content; margin: 0 auto; max-width: 60px;">Dia 2025 (USD)</th>';
    html += '<th style="padding:10px;border:1px solid #000;background-color:#002878;color:#ffffff; font-size: 12px; text-align: center; width: fit-content; margin: 0 auto; max-width: 60px;">Unid 2025</th>';
    html += '<th style="padding:10px;border:1px solid #000;background-color:#ECECEC;color:#000000; font-size: 12px; text-align: center; width: fit-content; margin: 0 auto; max-width: 60px;">% Crec Vta</th>';
    html += '<th style="padding:10px;border:1px solid #000;background-color:#ECECEC;color:#000000; font-size: 12px; text-align: center; width: fit-content; margin: 0 auto; max-width: 60px;">% Crec Unid</th>';
    html += '</tr></thead><tbody>';
  
    // Añadir fila de totales
    html += '<tr style="background-color: #bfbfbf; font-weight: bold;">';
    html += `<td style="padding:10px;border:1px solid #000;color:#000; text-align: left;">${totals["#"]}</td>`;
    html += `<td style="padding:10px;border:1px solid #000;color:#000; text-align: left;">${totals["Stores"]}</td>`;
    html += `<td style="padding:10px;border:1px solid #000;color:#000; text-align: right;">${parseFloat(totals["Dia 2024 (USD)"]).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>`;
    html += `<td style="padding:10px;border:1px solid #000;color:#000; text-align: right;">${parseInt(totals["Unid 2024"]).toLocaleString()}</td>`;
    html += `<td style="padding:10px;border:1px solid #000;color:#000; text-align: right;">${parseFloat(totals["Dia 2025 (USD)"]).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>`;
    html += `<td style="padding:10px;border:1px solid #000;color:#000; text-align: right;">${parseInt(totals["Unid 2025"]).toLocaleString()}</td>`;
    html += `<td style="padding:10px;border:1px solid #000;color:#000; text-align: right;">${totals["% Crec Vta"]}</td>`;
    html += `<td style="padding:10px;border:1px solid #000;color:#000; text-align: right;">${totals["% Crec Unid"]}</td>`;
    html += '</tr>';
  
    html += '</tbody></table></div>';
    return html;
  }
  
  // Calcular totales para datos acumulados
  const totalAccumulatedHtml = createTotalHTMLTable({
    "#": '',
    Stores: 'TOTAL',
    "Dia 2024 (USD)": dataAccumulated.reduce((acc, item) => acc + parseFloat(item["Dia 2024 (USD)"] || 0), 0).toFixed(2),
    "Unid 2024": dataAccumulated.reduce((acc, item) => acc + parseInt(item["Unid 2024"] || 0), 0).toFixed(0),
    "Dia 2025 (USD)": dataAccumulated.reduce((acc, item) => acc + parseFloat(item["Dia 2025 (USD)"] || 0), 0).toFixed(2),
    "Unid 2025": dataAccumulated.reduce((acc, item) => acc + parseInt(item["Unid 2025"] || 0), 0).toFixed(0),
    "% Crec Vta": (
      (dataAccumulated.reduce((acc, item) => acc + parseFloat(item["Dia 2025 (USD)"] || 0), 0) -
      dataAccumulated.reduce((acc, item) => acc + parseFloat(item["Dia 2024 (USD)"] || 0), 0)) /
      (dataAccumulated.reduce((acc, item) => acc + parseFloat(item["Dia 2024 (USD)"] || 0), 0) || 1) * 100
    ).toFixed(2) + '%',
    "% Crec Unid": (
      (dataAccumulated.reduce((acc, item) => acc + parseInt(item["Unid 2025"] || 0), 0) -
      dataAccumulated.reduce((acc, item) => acc + parseInt(item["Unid 2024"] || 0), 0)) /
      (dataAccumulated.reduce((acc, item) => acc + parseInt(item["Unid 2024"] || 0), 0) || 1) * 100
    ).toFixed(2) + '%',
  }, `TOTAL ACUMULADO`, 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Flag_of_Panama.svg/1920px-Flag_of_Panama.svg.png');
  
  // Calcular totales para datos diarios
  const totalDailyHtml = createTotalHTMLTable({
    "#": '',
    Stores: 'TOTAL',
    "Dia 2024 (USD)": dataDaily.reduce((acc, item) => acc + parseFloat(item["Dia 2024 (USD)"] || 0), 0).toFixed(2),
    "Unid 2024": dataDaily.reduce((acc, item) => acc + parseInt(item["Unid 2024"] || 0), 0).toFixed(0),
    "Dia 2025 (USD)": dataDaily.reduce((acc, item) => acc + parseFloat(item["Dia 2025 (USD)"] || 0), 0).toFixed(2),
    "Unid 2025": dataDaily.reduce((acc, item) => acc + parseInt(item["Unid 2025"] || 0), 0).toFixed(0),
    "% Crec Vta": (
      (dataDaily.reduce((acc, item) => acc + parseFloat(item["Dia 2025 (USD)"] || 0), 0) -
      dataDaily.reduce((acc, item) => acc + parseFloat(item["Dia 2024 (USD)"] || 0), 0)) /
      (dataDaily.reduce((acc, item) => acc + parseFloat(item["Dia 2024 (USD)"] || 0), 0) || 1) * 100
    ).toFixed(2) + '%',
    "% Crec Unid": (
      (dataDaily.reduce((acc, item) => acc + parseInt(item["Unid 2025"] || 0), 0) -
      dataDaily.reduce((acc, item) => acc + parseInt(item["Unid 2024"] || 0), 0)) /
      (dataDaily.reduce((acc, item) => acc + parseInt(item["Unid 2024"] || 0), 0) || 1) * 100
    ).toFixed(2) + '%',
  }, `TOTAL FECHA A FECHA`, 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Flag_of_Panama.svg/1920px-Flag_of_Panama.svg.png');
  
  
  const accumulatedHtml = createHTMLTable(columnsAccumulated, reindexedAccumulatedOtherStores, `INFORME ACUMULADO DEL ${format(ini_month, 'd').toUpperCase()} AL `, 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Flag_of_Panama.svg/1920px-Flag_of_Panama.svg.png');
  const dailyHtml = createHTMLTable(columnsDaily, reindexedDailyOtherStores, `INFORME FECHA A FECHA`, 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Flag_of_Panama.svg/1920px-Flag_of_Panama.svg.png');

  const canalModernoHtmlAccumulated = createHTMLTable(columnsAccumulated, reindexedAccumulatedCanalModerno, `CANAL MODERNO ACUMULADO`, 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Flag_of_Panama.svg/1920px-Flag_of_Panama.svg.png');
  const canalModernoHtmlDaily = createHTMLTable(columnsDaily, reindexedDailyCanalModerno, `CANAL MODERNO FECHA A FECHA`, 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Flag_of_Panama.svg/1920px-Flag_of_Panama.svg.png');

  const html = dailyHtml + '<br><br>' + canalModernoHtmlDaily + '<br><br>' + totalDailyHtml + '<br><br>' + accumulatedHtml + '<br><br>' + canalModernoHtmlAccumulated + '<br><br>' + totalAccumulatedHtml;
  
  return {
    html
  };
};

// Función para enviar el correo electrónico principal
const emailpnd = async (html) => {
  const transporter = nodemailer.createTransport({
    SES: ses,
  });

  const params = {
    from: 'comunicaciones.sistemas@fastmoda.com.co 🇵🇦 Venta_Lili_Panama',
    to: [
      'yeimy.jimenez@fastmoda.com.co',
    ],
    // to: [
    //   'yeimy.jimenez@fastmoda.com.co',
    //   'kevin.castillo@fastmoda.com.co',
    //   'andres.hernandez@fastmoda.com.co',
    //   'dany.pardo@fastmoda.com.co',
    //   'nassim@dvpty.com',
    //   'david@lilipink.com'
    // ],
    subject: 'Informe de ventas Panamá',
    html: html,
  };

  try {
    const info = await transporter.sendMail(params);
    console.log('Correo enviado exitosamente:', info);
  } catch (error) { 
    console.log('Error sending email:', error);
    throw error; // Re-lanzar el error para que pueda ser capturado en el bloque principal
  }
};

// Función exportada que maneja el envío de correos
exports.emailpnd = async () => {
  try {
    const { html } = await tableEmailAccumulated();
    await emailpnd(html);
    console.log("Correo enviado correctamente.");
  } catch (error) {
    console.error("Error al procesar el correo:", error);
    await sendErrorEmail(error);
    console.log("Correo de error enviado ");
  }
};
