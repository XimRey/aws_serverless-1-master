'use strict';
const { athena, ses } = require('../configurations/awsSetting');
const nodemailer = require('nodemailer');
const { format, subDays, startOfMonth, addMonths, subYears, endOfMonth, getDate, subMonths } = require('date-fns');

// Función para obtener la tasa de conversión
const getConversionRate = async () => {
  try {
    const response = await fetch('https://open.er-api.com/v6/latest/USD');
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    const data = await response.json();
    const rates = data.rates;
    const crcToUsdRate = rates['CRC'];
    return 1 / crcToUsdRate;
  } catch (error) {
    console.error('Error fetching conversion rate:', error);
    throw error;
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

// Función para ejecutar la consulta SQL con fechas y tasa de conversión
const executeSQLQuery = async (startDate, endDate, conversionRate, isAccumulated = false) => {
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

  // Ajuste para que finDate y finDatePastYear sean del día anterior
  finDate = subDays(new Date(), 1); // Día anterior a la fecha actual
  finDatePastYear = subDays(subYears(new Date(), 1), 1); // Día anterior a la fecha correspondiente del año pasado

  const query = `
    SELECT 
      CASE
          WHEN "CentroBeneficio" IN ('BOD001', 'ECOM102', 'EXP102', 'Vta_May') THEN 'CANAL MODERNO'
          WHEN "Stores" = '' OR "Stores" IS NULL THEN 'CANAL MODERNO' 
          ELSE "Stores" 
      END AS "Stores", 
      SUM("sales_ly") AS "Dia 2024 (CRC)", 
      SUM("sold_units_ly") AS "Unid 2024",
      SUM("sales") AS "Dia 2025 (CRC)", 
      SUM("sold_units") AS "Unid 2025",
      ROUND(CASE WHEN SUM(CAST("sales_ly" AS DOUBLE)) = 0 THEN 100 ELSE (SUM(CAST("sales" AS DOUBLE)) - SUM(CAST("sales_ly" AS DOUBLE))) / SUM(CAST("sales_ly" AS DOUBLE)) * 100 END, 2) AS "% Crec Vta",
      ROUND(CASE WHEN SUM(CAST("sold_units_ly" AS DOUBLE)) = 0 THEN 100 ELSE (SUM(CAST("sold_units" AS DOUBLE)) - SUM(CAST("sold_units_ly" AS DOUBLE))) / SUM(CAST("sold_units_ly" AS DOUBLE)) * 100 END, 2) AS "% Crec Unid"
    FROM ( 
      --2024
      SELECT 
          T1."ocrcode" AS "CentroBeneficio",    
          B1."col1" AS "Stores",
          SUM(CAST(T1."Quantity" AS DOUBLE)) AS "sold_units_ly",
          SUM(CAST((T1."LineTotal" - (T1."LineTotal" * COALESCE(T0."DiscPrcnt", 0) / 100)) AS DECIMAL(18, 2))) AS "sales_ly",
          0 AS "sold_units", 
          0 AS "sales"
      FROM "sap-b1-lili-pink-cr"."OINV" T0 
      INNER JOIN "sap-b1-lili-pink-cr"."INV1" T1 ON T0."DocEntry" = T1."DocEntry" 
      LEFT JOIN "sap-b1-lili-pink-cr"."business_units" B1 ON T1."ocrcode" = B1."col0"
      WHERE T0."DocDate" BETWEEN date '${format(iniDatePastYear, 'yyyy-MM-dd')}' AND TIMESTAMP '${format(finDatePastYear, 'yyyy-MM-dd')}' 
        AND T1."AcctCode" IN ('41209501', '41209504', '41209505', '41359501', '41750201', '41750301') 
      GROUP BY T1."ocrcode", B1."col1"
      
      UNION ALL
      
      SELECT 
          T1."ocrcode" AS "CentroBeneficio",    
          B1."col1" AS "Stores",
          SUM(CAST(T1."Quantity" AS DOUBLE)) * -1 AS "sold_units_ly",
          SUM(CAST(-(T1."LineTotal" - (T1."LineTotal" * (COALESCE(T0."DiscPrcnt", 0) / 100))) AS DECIMAL(18, 2))) AS "sales_ly",
          0 AS "sold_units", 
          0 AS "sales"
      FROM "sap-b1-lili-pink-cr"."ORIN" T0 
      INNER JOIN "sap-b1-lili-pink-cr"."RIN1" T1 ON T0."DocEntry" = T1."DocEntry" 
      LEFT JOIN "sap-b1-lili-pink-cr"."business_units" B1 ON T1."ocrcode" = B1."col0"
      WHERE T0."DocDate" BETWEEN date '${format(iniDatePastYear, 'yyyy-MM-dd')}' AND TIMESTAMP '${format(finDatePastYear, 'yyyy-MM-dd')}' 
        AND T1."AcctCode" IN ('41209501', '41209504', '41209505', '41359501', '41750201', '41750301') 
      GROUP BY T1."ocrcode", B1."col1"
      
      UNION ALL
      
      SELECT 
          T1."ProfitCode" AS "CentroBeneficio",
          B1."col1" AS "Stores",
          0 AS "sold_units_ly",
          CAST(SUM(CAST(T1."Debit" AS DOUBLE) - CAST(T1."Credit" AS DOUBLE)) * -1 AS DECIMAL(18, 2)) AS "sales_ly",
          0 AS "sold_units", 
          0 AS "sales"
      FROM "sap-b1-lili-pink-cr"."OJDT" T0 
      INNER JOIN "sap-b1-lili-pink-cr"."JDT1" T1 ON T0."TransId" = T1."TransId"
      LEFT JOIN "sap-b1-lili-pink-cr"."business_units" B1 ON T1."ProfitCode" = B1."col0"
      WHERE T0."RefDate" BETWEEN date '${format(iniDatePastYear, 'yyyy-MM-dd')}' AND TIMESTAMP '${format(finDatePastYear, 'yyyy-MM-dd')}' 
        AND T1."Account" IN ('41209501', '41209504', '41209505', '41359501', '41750201', '41750301') 
        AND T0."TransType" = '30' 
      GROUP BY T1."ProfitCode", B1."col1"
      
      UNION ALL    
      
      --2025
      SELECT 
          T1."ocrcode" AS "CentroBeneficio",    
          B1."col1" AS "Stores",
          0 AS "sold_units_ly", 
          0 AS "sales_ly",
          SUM(CAST(T1."Quantity" AS DOUBLE)) AS "sold_units",
          SUM(CAST((T1."LineTotal" - (T1."LineTotal" * COALESCE(T0."DiscPrcnt", 0) / 100)) AS DECIMAL(18, 2))) AS "sales"
      FROM "sap-b1-lili-pink-cr"."OINV" T0 
      INNER JOIN "sap-b1-lili-pink-cr"."INV1" T1 ON T0."DocEntry" = T1."DocEntry"
      LEFT JOIN "sap-b1-lili-pink-cr"."business_units" B1 ON T1."ocrcode" = B1."col0"
      WHERE T0."DocDate" BETWEEN date '${format(iniDate, 'yyyy-MM-dd')}' AND TIMESTAMP '${format(finDate, 'yyyy-MM-dd')}' 
        AND T1."AcctCode" IN ('41209501', '41209504', '41209505', '41359501', '41750201', '41750301') 
      GROUP BY T1."ocrcode", B1."col1"
      
      UNION ALL
      
      SELECT 
          T1."ocrcode" AS "CentroBeneficio",    
          B1."col1" AS "Stores",
          0 AS "sold_units_ly",
          0 AS "sales_ly",
          SUM(CAST(T1."Quantity" AS DOUBLE)) * -1 AS "sold_units",
          SUM(CAST(-(T1."LineTotal" - (T1."LineTotal" * (COALESCE(T0."DiscPrcnt", 0) / 100))) AS DECIMAL(18, 2))) AS "sales"
      FROM "sap-b1-lili-pink-cr"."ORIN" T0 
      INNER JOIN "sap-b1-lili-pink-cr"."RIN1" T1 ON T0."DocEntry" = T1."DocEntry"
      LEFT JOIN "sap-b1-lili-pink-cr"."business_units" B1 ON T1."ocrcode" = B1."col0"
      WHERE T0."DocDate" BETWEEN date '${format(iniDate, 'yyyy-MM-dd')}' AND TIMESTAMP '${format(finDate, 'yyyy-MM-dd')}' 
        AND T1."AcctCode" IN ('41209501', '41209504', '41209505', '41359501', '41750201', '41750301') 
      GROUP BY T1."ocrcode", B1."col1"
      
      UNION ALL
      
      SELECT 
          T1."ProfitCode" AS "CentroBeneficio",
          B1."col1" AS "Stores",
          0 AS "sold_units_ly",
          0 AS "sales_ly",
          0 AS "sold_units",
          CAST(SUM(CAST(T1."Debit" AS DOUBLE) - CAST(T1."Credit" AS DOUBLE)) * -1 AS DECIMAL(18, 2)) AS "sales"
      FROM "sap-b1-lili-pink-cr"."OJDT" T0 
      INNER JOIN "sap-b1-lili-pink-cr"."JDT1" T1 ON T0."TransId" = T1."TransId"
      LEFT JOIN "sap-b1-lili-pink-cr"."business_units" B1 ON T1."ProfitCode" = B1."col0"
      WHERE T0."RefDate" BETWEEN date '${format(iniDate, 'yyyy-MM-dd')}' AND TIMESTAMP '${format(finDate, 'yyyy-MM-dd')}' 
        AND T1."Account" IN ('41209501', '41209504', '41209505', '41359501', '41750201', '41750301') 
        AND T0."TransType" = '30' 
      GROUP BY T1."ProfitCode", B1."col1"
    ) AS combined
    GROUP BY 
      CASE 
        WHEN "CentroBeneficio" IN ('BOD001', 'ECOM102', 'EXP102', 'Vta_May') THEN 'CANAL MODERNO'
        WHEN "Stores" = '' OR "Stores" IS NULL THEN 'CANAL MODERNO' 
        ELSE "Stores" 
      END 
    ORDER BY "Stores";
  `;
  //console.log(query)
  const result = await executeSQLMethod(query);

  // Verificación de resultados vacíos
  if (!result || result.length === 0) {
    throw new Error('La consulta SQL retornó resultados vacíos.');
  }

  // Get column names
  const columns = ["#", "Stores", "Dia 2024 (CRC)", "Unid 2024", "Dia 2025 (CRC)", "Unid 2025", "Dia 2024 (USD)", "Dia 2025 (USD)", "% Crec Vta", "% Crec Unid"];

  const data = result.map((item, index) => {
    return {
      "#": index + 1,
      ...item,
      "Dia 2024 (USD)": (parseFloat(item["Dia 2024 (CRC)"]) * conversionRate).toFixed(2),
      "Dia 2025 (USD)": (parseFloat(item["Dia 2025 (CRC)"]) * conversionRate).toFixed(2)
    };
  });

  return { columns, data };
};

// Función principal para generar el contenido del email
const tableEmailAccumulated = async () => {
  let conversionRate;
  try {
    conversionRate = await getConversionRate();
  } catch (error) {
    throw new Error('No se pudo obtener la tasa de conversión.');
  }

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
    ({ columns: columnsAccumulated, data: dataAccumulated } = await executeSQLQuery(ini_month, primer_dia_mes_siguiente, conversionRate, true));
    ({ columns: columnsDaily, data: dataDaily } = await executeSQLQuery(yesterday, today, conversionRate, false));
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
    // Calculate totals
    let totals = {
      "#": '',
      Stores: 'TOTAL',
      "Dia 2024 (CRC)": 0,
      "Unid 2024": 0,
      "Dia 2025 (CRC)": 0,
      "Unid 2025": 0,
      "Dia 2024 (USD)": 0,
      "Dia 2025 (USD)": 0,
      "% Crec Vta": 0,
      "% Crec Unid": 0,
    };

    data.forEach(item => {
      totals["Dia 2024 (CRC)"] += parseFloat((parseFloat((item["Dia 2024 (CRC)"] || "0").replace(',', '')) || 0).toFixed(2));
      totals["Unid 2024"] += parseInt((item["Unid 2024"] || "0").replace(/,/g, '')) || 0;
      totals["Dia 2025 (CRC)"] += parseFloat((parseFloat((item["Dia 2025 (CRC)"] || "0").replace(',', '')) || 0).toFixed(2));
      totals["Unid 2025"] += parseInt((item["Unid 2025"] || "0").replace(/,/g, '')) || 0;
      totals["Dia 2024 (USD)"] += parseFloat((parseFloat((item["Dia 2024 (USD)"] || "0").replace(',', '')) || 0).toFixed(2));
      totals["Dia 2025 (USD)"] += parseFloat((parseFloat((item["Dia 2025 (USD)"] || "0").replace(',', '')) || 0).toFixed(2));
    });

    // Calculate growth rates
    totals["% Crec Vta"] = (
      (totals["Dia 2025 (USD)"] - totals["Dia 2024 (USD)"]) /
      (totals["Dia 2024 (USD)"] || 1) * 100
    ).toFixed(2);

    totals["% Crec Unid"] = (
      (totals["Unid 2025"] - totals["Unid 2024"]) /
      (totals["Unid 2024"] || 1) * 100
    ).toFixed(2);

    let html = '<div style="padding: 20px; border: 4px solid #D3D3E9; border-radius: 15px; text-align: left; width: fit-content;">';
    html += `<p style="background-color:#D8D8EB; padding: 10px 20px; color: #3D3D7A; width: fit-content; border-radius: 15px; font-weight:500; margin: 0 0 0 6px; text-align: center;">`;
    html += `<img src="${iconUrl}" style="width:20px; height:15px; margin-right: 10px; vertical-align: middle;">`;
    html += `${title} ${subDays(today, 1).toLocaleString('es-CO', { timeZone: 'America/Bogota', day: 'numeric', month: 'long' }).toUpperCase()}</p><br>`;
    html += '<table style="border-collapse:collapse; font-family: Arial; font-size: 12px; border-radius: 15px;"><thead><tr>';

    // Create table headers
    html += '<th style="padding:10px;border:1px solid #000;background-color:#bfbfbf;color:#000000; font-size: 12px; text-align: center; width: fit-content; margin: 0 auto;">#</th>';
    html += '<th style="padding:10px;border:1px solid #000;background-color:#bfbfbf;color:#000000; font-size: 12px; text-align: center; width: fit-content; margin: 0 auto;">Store</th>';
    html += '<th style="padding:10px;border:1px solid #000;background-color:#002878;color:#ffffff; font-size: 12px; text-align: center; width: fit-content; margin: 0 auto; max-width: 60px;">Dia 2024 (CRC)</th>';
    html += '<th style="padding:10px;border:1px solid #000;background-color:#002878;color:#ffffff; font-size: 12px; text-align: center; width: fit-content; margin: 0 auto; max-width: 60px;">Unid 2024</th>';
    html += '<th style="padding:10px;border:1px solid #000;background-color:#ECECEC;color:#000000; font-size: 12px; text-align: center; width: fit-content; margin: 0 auto; max-width: 60px;">Dia 2025 (CRC)</th>';
    html += '<th style="padding:10px;border:1px solid #000;background-color:#ECECEC;color:#000000; font-size: 12px; text-align: center; width: fit-content; margin: 0 auto; max-width: 60px;">Unid 2025</th>';
    html += '<th style="padding:10px;border:1px solid #000;background-color:#C81020;color:#ffffff; font-size: 12px; text-align: center; width: fit-content; margin: 0 auto; max-width: 60px;">Dia 2024 (USD)</th>';
    html += '<th style="padding:10px;border:1px solid #000;background-color:#C81020;color:#ffffff; font-size: 12px; text-align: center; width: fit-content; margin: 0 auto; max-width: 60px;">Dia 2025 (USD)</th>';
    html += '<th style="padding:10px;border:1px solid #000;background-color:#002878;color:#ffffff; font-size: 12px; text-align: center; width: fit-content; margin: 0 auto; max-width: 60px;">% Crec Vta</th>';
    html += '<th style="padding:10px;border:1px solid #000;background-color:#002878;color:#ffffff; font-size: 12px; text-align: center; width: fit-content; margin: 0 auto; max-width: 60px;">% Crec Unid</th>';
    html += '</tr></thead><tbody>';

    // Create table rows
    data.forEach((item, index) => {
      let backgroundColor = index % 2 === 0 ? '#F9F9FC' : '#EDEDF5';
      html += `<tr style="background-color: ${backgroundColor};">`;

      html += `<td style="padding:10px;border:1px solid #000;color:#000; background-color:#f2f2f2; font-weight:300; text-align: left;">${item["#"] || ''}</td>`;
      html += `<td style="padding:10px;border:1px solid #000;color:#000; background-color:#f2f2f2; font-weight:300; text-align: left;">${item["Stores"] || ''}</td>`;
      html += `<td style="padding:10px;border:1px solid #000;color:#000; background-color:#E5EBFF; font-weight:300; text-align: right;">${Number(item["Dia 2024 (CRC)"] || 0).toLocaleString()}</td>`;
      html += `<td style="padding:10px;border:1px solid #000;color:#000; background-color:#E5EBFF; font-weight:300; text-align: right;">${Number(item["Unid 2024"] || 0).toLocaleString()}</td>`;
      html += `<td style="padding:10px;border:1px solid #000;color:#000; background-color:#FDFDFD; font-weight:300; text-align: right;">${Number(item["Dia 2025 (CRC)"] || 0).toLocaleString()}</td>`;
      html += `<td style="padding:10px;border:1px solid #000;color:#000; background-color:#FDFDFD; font-weight:300; text-align: right;">${Number(item["Unid 2025"] || 0).toLocaleString()}</td>`;
      html += `<td style="padding:10px;border:1px solid #000;color:#000; background-color:#FFE5E7; font-weight:300; text-align: right;">${Number(item["Dia 2024 (USD)"] || 0).toLocaleString()}</td>`;
      html += `<td style="padding:10px;border:1px solid #000;color:#000; background-color:#FFE5E7; font-weight:300; text-align: right;">${Number(item["Dia 2025 (USD)"] || 0).toLocaleString()}</td>`;
      html += `<td style="padding:10px;border:1px solid #000;color:#000; background-color:#E5EBFF; font-weight:300; text-align: right;">${Number(item["% Crec Vta"] || 0).toLocaleString()}%</td>`;
      html += `<td style="padding:10px;border:1px solid #000;color:#000; background-color:#E5EBFF; font-weight:300; text-align: right;">${Number(item["% Crec Unid"] || 0).toLocaleString()}%</td>`;
      html += '</tr>';
    });

    // Add totals row
    html += '<tr style="background-color: #bfbfbf; font-weight: bold;">';
    html += `<td style="padding:10px;border:1px solid #000;color:#000; text-align: left;">${totals["#"]}</td>`;
    html += `<td style="padding:10px;border:1px solid #000;color:#000; text-align: left;">${totals["Stores"]}</td>`;
    html += `<td style="padding:10px;border:1px solid #000;color:#000; text-align: right;">${totals["Dia 2024 (CRC)"].toLocaleString()}</td>`;
    html += `<td style="padding:10px;border:1px solid #000;color:#000; text-align: right;">${totals["Unid 2024"].toLocaleString()}</td>`;
    html += `<td style="padding:10px;border:1px solid #000;color:#000; text-align: right;">${totals["Dia 2025 (CRC)"].toLocaleString()}</td>`;
    html += `<td style="padding:10px;border:1px solid #000;color:#000; text-align: right;">${totals["Unid 2025"].toLocaleString()}</td>`;
    html += `<td style="padding:10px;border:1px solid #000;color:#000; text-align: right;">${totals["Dia 2024 (USD)"].toLocaleString()}</td>`;
    html += `<td style="padding:10px;border:1px solid #000;color:#000; text-align: right;">${totals["Dia 2025 (USD)"].toLocaleString()}</td>`;
    html += `<td style="padding:10px;border:1px solid #000;color:#000; text-align: right;">${totals["% Crec Vta"]}%</td>`;
    html += `<td style="padding:10px;border:1px solid #000;color:#000; text-align: right;">${totals["% Crec Unid"]}%</td>`;
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
  
    // Create table headers
    html += '<th style="padding:10px;border:1px solid #000;background-color:#bfbfbf;color:#000000; font-size: 12px; text-align: center; width: fit-content; margin: 0 auto;">#</th>';
    html += '<th style="padding:10px;border:1px solid #000;background-color:#bfbfbf;color:#000000; font-size: 12px; text-align: center; width: fit-content; margin: 0 auto;">Store</th>';
    html += '<th style="padding:10px;border:1px solid #000;background-color:#002878;color:#ffffff; font-size: 12px; text-align: center; width: fit-content; margin: 0 auto; max-width: 60px;">Dia 2024 (CRC)</th>';
    html += '<th style="padding:10px;border:1px solid #000;background-color:#002878;color:#ffffff; font-size: 12px; text-align: center; width: fit-content; margin: 0 auto; max-width: 60px;">Unid 2024</th>';
    html += '<th style="padding:10px;border:1px solid #000;background-color:#ECECEC;color:#000000; font-size: 12px; text-align: center; width: fit-content; margin: 0 auto; max-width: 60px;">Dia 2025 (CRC)</th>';
    html += '<th style="padding:10px;border:1px solid #000;background-color:#ECECEC;color:#000000; font-size: 12px; text-align: center; width: fit-content; margin: 0 auto; max-width: 60px;">Unid 2025</th>';
    html += '<th style="padding:10px;border:1px solid #000;background-color:#C81020;color:#ffffff; font-size: 12px; text-align: center; width: fit-content; margin: 0 auto; max-width: 60px;">Dia 2024 (USD)</th>';
    html += '<th style="padding:10px;border:1px solid #000;background-color:#C81020;color:#ffffff; font-size: 12px; text-align: center; width: fit-content; margin: 0 auto; max-width: 60px;">Dia 2025 (USD)</th>';
    html += '<th style="padding:10px;border:1px solid #000;background-color:#002878;color:#ffffff; font-size: 12px; text-align: center; width: fit-content; margin: 0 auto; max-width: 60px;">% Crec Vta</th>';
    html += '<th style="padding:10px;border:1px solid #000;background-color:#002878;color:#ffffff; font-size: 12px; text-align: center; width: fit-content; margin: 0 auto; max-width: 60px;">% Crec Unid</th>';
    html += '</tr></thead><tbody>';
  
    // Add totals row
    html += '<tr style="background-color: #bfbfbf; font-weight: bold;">';
    html += `<td style="padding:10px;border:1px solid #000;color:#000; text-align: left;">${totals["#"]}</td>`;
    html += `<td style="padding:10px;border:1px solid #000;color:#000; text-align: left;">${totals["Stores"]}</td>`;
    html += `<td style="padding:10px;border:1px solid #000;color:#000; text-align: right;">${parseFloat(totals["Dia 2024 (CRC)"]).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>`;
    html += `<td style="padding:10px;border:1px solid #000;color:#000; text-align: right;">${parseInt(totals["Unid 2024"]).toLocaleString()}</td>`;
    html += `<td style="padding:10px;border:1px solid #000;color:#000; text-align: right;">${parseFloat(totals["Dia 2025 (CRC)"]).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>`;
    html += `<td style="padding:10px;border:1px solid #000;color:#000; text-align: right;">${parseInt(totals["Unid 2025"]).toLocaleString()}</td>`;
    html += `<td style="padding:10px;border:1px solid #000;color:#000; text-align: right;">${parseFloat(totals["Dia 2024 (USD)"]).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>`;
    html += `<td style="padding:10px;border:1px solid #000;color:#000; text-align: right;">${parseFloat(totals["Dia 2025 (USD)"]).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>`;
    html += `<td style="padding:10px;border:1px solid #000;color:#000; text-align: right;">${totals["% Crec Vta"]}%</td>`;
    html += `<td style="padding:10px;border:1px solid #000;color:#000; text-align: right;">${totals["% Crec Unid"]}%</td>`;
    html += '</tr>';
  
    html += '</tbody></table></div>';
    return html;
  }
  
  // Calculate totals for accumulated data
  const totalAccumulatedHtml = createTotalHTMLTable({
    "#": '',
    Stores: 'TOTAL',
    "Dia 2024 (CRC)": dataAccumulated.reduce((acc, item) => acc + parseFloat(item["Dia 2024 (CRC)"] || 0), 0).toFixed(2),
    "Unid 2024": dataAccumulated.reduce((acc, item) => acc + parseInt(item["Unid 2024"] || 0), 0).toFixed(0),
    "Dia 2025 (CRC)": dataAccumulated.reduce((acc, item) => acc + parseFloat(item["Dia 2025 (CRC)"] || 0), 0).toFixed(2),
    "Unid 2025": dataAccumulated.reduce((acc, item) => acc + parseInt(item["Unid 2025"] || 0), 0).toFixed(0),
    "Dia 2024 (USD)": dataAccumulated.reduce((acc, item) => acc + parseFloat(item["Dia 2024 (USD)"] || 0), 0).toFixed(2),
    "Dia 2025 (USD)": dataAccumulated.reduce((acc, item) => acc + parseFloat(item["Dia 2025 (USD)"] || 0), 0).toFixed(2),
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
  }, `TOTAL ACUMULADO`, 'https://upload.wikimedia.org/wikipedia/commons/thumb/f/f2/Flag_of_Costa_Rica.svg/1024px-Flag_of_Costa_Rica.svg.png');

  // Calculate totals for daily data
  const totalDailyHtml = createTotalHTMLTable({
    "#": '',
    Stores: 'TOTAL',
    "Dia 2024 (CRC)": dataDaily.reduce((acc, item) => acc + parseFloat(item["Dia 2024 (CRC)"] || 0), 0).toFixed(2),
    "Unid 2024": dataDaily.reduce((acc, item) => acc + parseInt(item["Unid 2024"] || 0), 0).toFixed(0),
    "Dia 2025 (CRC)": dataDaily.reduce((acc, item) => acc + parseFloat(item["Dia 2025 (CRC)"] || 0), 0).toFixed(2),
    "Unid 2025": dataDaily.reduce((acc, item) => acc + parseInt(item["Unid 2025"] || 0), 0).toFixed(0),
    "Dia 2024 (USD)": dataDaily.reduce((acc, item) => acc + parseFloat(item["Dia 2024 (USD)"] || 0), 0).toFixed(2),
    "Dia 2025 (USD)": dataDaily.reduce((acc, item) => acc + parseFloat(item["Dia 2025 (USD)"] || 0), 0).toFixed(2),
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
  }, `TOTAL FECHA A FECHA`, 'https://upload.wikimedia.org/wikipedia/commons/thumb/f/f2/Flag_of_Costa_Rica.svg/1024px-Flag_of_Costa_Rica.svg.png');

  
  const accumulatedHtml = createHTMLTable(columnsAccumulated, reindexedAccumulatedOtherStores, `INFORME ACUMULADO DEL ${format(ini_month, 'd').toUpperCase()} AL `, 'https://upload.wikimedia.org/wikipedia/commons/thumb/f/f2/Flag_of_Costa_Rica.svg/1024px-Flag_of_Costa_Rica.svg.png');
  const dailyHtml = createHTMLTable(columnsDaily, reindexedDailyOtherStores, `INFORME FECHA A FECHA`, 'https://upload.wikimedia.org/wikipedia/commons/thumb/f/f2/Flag_of_Costa_Rica.svg/1024px-Flag_of_Costa_Rica.svg.png');

  const canalModernoHtmlAccumulated = createHTMLTable(columnsAccumulated, reindexedAccumulatedCanalModerno, `CANAL MODERNO ACUMULADO`, 'https://upload.wikimedia.org/wikipedia/commons/thumb/f/f2/Flag_of_Costa_Rica.svg/1024px-Flag_of_Costa_Rica.svg.png');
  const canalModernoHtmlDaily = createHTMLTable(columnsDaily, reindexedDailyCanalModerno, `CANAL MODERNO FECHA A FECHA`, 'https://upload.wikimedia.org/wikipedia/commons/thumb/f/f2/Flag_of_Costa_Rica.svg/1024px-Flag_of_Costa_Rica.svg.png');

  const html = dailyHtml + '<br><br>' + canalModernoHtmlDaily + '<br><br>' + totalDailyHtml + '<br><br>' + accumulatedHtml + '<br><br>' + canalModernoHtmlAccumulated + '<br><br>' + totalAccumulatedHtml;
  
  return {
    html
  };
};

// Función para enviar el correo electrónico principal
const emailcr = async (html) => {
  const transporter = nodemailer.createTransport({
    SES: ses,
  });

  const params = {
    from: 'comunicaciones.sistemas@fastmoda.com.co 🇨🇷 Venta_Lili_Costa_Rica',
    to: ['yeimy.jimenez@fastmoda.com.co',
      'andres.hernandez@fastmoda.com.co',
      'kevin.castillo@fastmoda.com.co',
      'nassim@dvpty.com',
      'paola.diaz@fastmoda.com.co',
      'alejandro.mosquera@fastmoda.com.co',
      'admin@lilipinkcr.com'], 
    // to: ['yeimy.jimenez@fastmoda.com.co'],
    subject: 'Informe de ventas Costa Rica',
    html: html,
  };

  try {
    const info = await transporter.sendMail(params);
    console.log('Email sent successfully:', info);
  } catch (error) {
    console.log('Error sending email:', error);
    throw error; // Re-lanzar el error para que pueda ser capturado en el bloque principal
  }
};

// Nueva función para enviar correos de error a Cristian
const sendErrorEmail = async (error) => {
  const transporter = nodemailer.createTransport({
    SES: ses,
  });

  const params = {
    from: 'comunicaciones.sistemas@fastmoda.com.co 🇨🇷 Venta_Lili_Costa_Rica',
    to: ['yeimy.jimenez@fastmoda.com.co'],
    subject: 'Error en el Informe de Ventas Costa Rica',
    html: `<p>Ha ocurrido un error al ejecutar el informe de ventas Costa Rica:</p><p>${error.message}</p>`,
  };

  try {
    const info = await transporter.sendMail(params);
    console.log('Correo de error enviado exitosamente:', info);
  } catch (err) {
    console.log('Error al enviar el correo de error:', err);
  }
};

// Función exportada que maneja el envío de correos
exports.emailcr = async () => {
  try {
    const { html } = await tableEmailAccumulated();
    await emailcr(html);
    console.log("Correo enviado correctamente.");
  } catch (error) {
    console.error("Error al procesar el correo:", error);
    await sendErrorEmail(error);
    console.log("Correo de error enviado ");
  }
};
