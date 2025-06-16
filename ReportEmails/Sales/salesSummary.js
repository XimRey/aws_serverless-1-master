'use strict';
const { athena, ses } = require('../../configurations/awsSetting');
const nodemailer = require('nodemailer');
const { format, subDays, startOfMonth, addMonths, subYears, getDate, subMonths } = require('date-fns');
const { es } = require('date-fns/locale');

const sendErrorEmail = async (error) => {
  const transporter = nodemailer.createTransport({
    SES: ses,
  });

  const params = {
    from: 'comunicaciones.sistemas@fastmoda.com.co' ,
    to: ['ximena.rey@fastmoda.com.co'],
    subject: 'Error en el Informe de Ventas Colombia',
    html: `<p>Ha ocurrido un error al ejecutar el informe de ventas Colombia:</p><p>${error.message}</p>`,
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



// Función para construir el HTML del correo
const generateEmailBody = async () => {
  const query = `
    SELECT 
      unidaddenegocio,
      sum(totalunidadesperiodo1) as und_ly,
      sum(totalventasperiodo1) as vta_ly,
      sum(totalunidadesperiodo1) as und_cy,
      sum(totalventasperiodo1) as vta_cy 
    FROM "cegid-sql-server-analytics"."data_consolidated_sales"
    WHERE 
      fechainicioperiodo2 BETWEEN timestamp '2025-05-01 00:00:00.000' AND timestamp '2025-06-01 00:00:00.000'
      AND fechafinperiodo2 BETWEEN timestamp '2025-05-01 00:00:00.000' AND timestamp '2025-06-01 00:00:00.000'
    GROUP BY unidaddenegocio;
  `;
    
  const result = await executeSQLMethod(query);
  if (!result || result.length === 0) {
    throw new Error("La consulta SQL no devolvió datos.");
  }

  const propias = [];
  const franquicias = [];

  
  result.forEach((item, index) => {
    const nombre = item.unidaddenegocio?.toLowerCase() || "";
    const row = {
      "#": index + 1,
      unidaddenegocio: item.unidaddenegocio || 'N/A',
      und_ly: parseInt(item.und_ly || "0"),
      vta_ly: parseFloat(item.vta_ly || "0"),
      und_cy: parseInt(item.und_cy || "0"),
      vta_cy: parseFloat(item.vta_cy || "0"),
      ticket_ly: (parseFloat(item.vta_ly || "0") / parseInt(item.und_ly || "1")).toFixed(2),
      ticket_cy: (parseFloat(item.vta_cy || "0") / parseInt(item.und_cy || "1")).toFixed(2),
      growth_vta: (
        ((parseFloat(item.vta_cy || "0") - parseFloat(item.vta_ly || "0")) / parseFloat(item.vta_ly || "1")) * 100
      ).toFixed(2),
      growth_und: (
        ((parseFloat(item.und_cy || "0") - parseFloat(item.und_ly || "0")) / parseFloat(item.und_ly || "1")) * 100
      ).toFixed(2),
      store_ly: 1,
      store_cy: 1,
      trx_ly: 1,
      trx_cy: 1,
      growth_trx: 0,
      ppto: 0,
      cumplimiento: 0,
    };
  
    if (nombre.includes("frq")) {
      franquicias.push(row);
    } else if (
      nombre.includes("lilipink") || 
      nombre.includes("yoi") || 
      nombre.includes("yahad")
    ) {
      propias.push(row);
    }
    
  });

  const data = [...propias, ...franquicias]; 
  let totalUndLy = 0, totalVtaLy = 0, totalUndCy = 0, totalVtaCy = 0;
  data.forEach(item => {
    totalUndLy += item.und_ly;
    totalVtaLy += item.vta_ly;
    totalUndCy += item.und_cy;
    totalVtaCy += item.vta_cy;
  });

  console.log("Ejemplo de item:", data[0]);

  function generarTablaHTML(data) {
    return `
       <table style="width: 100%; border-collapse: collapse; font-size: 14px; margin-bottom: 32px;">
      <thead>
        <tr style="background-color: #f2f2f2; text-align: center;">
          <th style="border: 1px solid #ccc; padding: 6px;">Unidad de negocio</th>
          <th colspan="4" style="background-color: #f6e3f7;">Día 2024</th>
          <th colspan="4" style="background-color: #d2f0f3;">Día 2025</th>
          <th colspan="3" style="background-color: #f0e6ff;">Variación %</th>
          <th colspan="2" style="background-color: #d8c9ec;">Presupuesto</th>
        </tr>
        <tr style="text-align: center;">
          <th style="border: 1px solid #ccc; padding: 6px;"></th>
          <th style="border: 1px solid #ccc; padding: 6px;">#Store</th>
          <th style="border: 1px solid #ccc; padding: 6px;">Und</th>
          <th style="border: 1px solid #ccc; padding: 6px;">Trx</th>
          <th style="border: 1px solid #ccc; padding: 6px;">Ticketpr</th>
          <th style="border: 1px solid #ccc; padding: 6px;">#Store</th>
          <th style="border: 1px solid #ccc; padding: 6px;">Und</th>
          <th style="border: 1px solid #ccc; padding: 6px;">Trx</th>
          <th style="border: 1px solid #ccc; padding: 6px;">Ticketpr</th>
          <th style="border: 1px solid #ccc; padding: 6px;">%Crec vta</th>
          <th style="border: 1px solid #ccc; padding: 6px;">%Crec und</th>
          <th style="border: 1px solid #ccc; padding: 6px;">%Crec trx</th>
          <th style="border: 1px solid #ccc; padding: 6px;">Ppto día</th>
          <th style="border: 1px solid #ccc; padding: 6px;">%Cump día</th>
        </tr>
      </thead>
      <tbody>
        ${data.map(row => `
          <tr>
            <td style="border: 1px solid #ccc; padding: 6px;">${row.unidaddenegocio}</td>
            <td style="border: 1px solid #ccc; padding: 6px; text-align: right; background-color: #f6e3f7;">${row.store_ly}</td>
            <td style="border: 1px solid #ccc; padding: 6px; text-align: right; background-color: #f6e3f7;">${row.und_ly}</td>
            <td style="border: 1px solid #ccc; padding: 6px; text-align: right; background-color: #f6e3f7;">${row.trx_ly}</td>
            <td style="border: 1px solid #ccc; padding: 6px; text-align: right; background-color: #f6e3f7;">${row.ticket_ly}</td>

            <td style="border: 1px solid #ccc; padding: 6px; text-align: right; background-color: #d2f0f3;">${row.store_cy}</td>
            <td style="border: 1px solid #ccc; padding: 6px; text-align: right; background-color: #d2f0f3;">${row.und_cy}</td>
            <td style="border: 1px solid #ccc; padding: 6px; text-align: right; background-color: #d2f0f3;">${row.trx_cy}</td>
            <td style="border: 1px solid #ccc; padding: 6px; text-align: right; background-color: #d2f0f3;">${row.ticket_cy}</td>

            <td style="border: 1px solid #ccc; padding: 6px; text-align: right; background-color: #f0e6ff;">${row.growth_vta}%</td>
            <td style="border: 1px solid #ccc; padding: 6px; text-align: right; background-color: #f0e6ff;">${row.growth_und}%</td>
            <td style="border: 1px solid #ccc; padding: 6px; text-align: right; background-color: #f0e6ff;">${row.growth_trx}%</td>

            <td style="border: 1px solid #ccc; padding: 6px; text-align: right; background-color: #d8c9ec;">${row.ppto}</td>
            <td style="border: 1px solid #ccc; padding: 6px; text-align: right; background-color: #d8c9ec;">${row.cumplimiento}%</td>
          </tr>
        `).join('')}
        <tr style="font-weight: bold; background-color: #f0f8ff;">
          <td style="border: 1px solid #ccc; padding: 6px;">Total</td>
          <td colspan="13" style="border: 1px solid #ccc; padding: 6px;"></td>
        </tr>
      </tbody>
    </table>
    `;
  }

  return `
  <div style="font-family: Arial, sans-serif; padding: 16px;">
    <h2 style="background-color: #5e2b97; color: white; padding: 8px; text-align: center; border-radius: 12px;">
      <strong>** INFORME DIA A DIA ( Miércoles - Miércoles ) **</strong>
    </h2>

    <!-- Tabla de Propias -->
    <h3 style="color: #5e2b97;">* Informe de Tiendas Propias del 11 de Jun - 3:15PM</h3>
    ${generarTablaHTML(propias)}

    <!-- Tabla de Franquicias -->
    <h3 style="color: #5e2b97;">* Informe de Franquicias del 11 de Jun - 3:15PM</h3>
    ${generarTablaHTML(franquicias)}
  </div>
`;

};

// Función para enviar correo
const sendEmail = async (html) => {
  const transporter = nodemailer.createTransport({ SES: ses });

  const mailOptions = {
    from: 'comunicaciones.sistemas@fastmoda.com.co',
    to: ['ximena.rey@fastmoda.com.co','fernando.angarita@fastmoda.com.co'],
    subject: 'Informe de ventas Colombia',
    html: html,
  };

  try {
    const info = await transporter.sendMail(mailOptions);
    console.log('Correo enviado exitosamente:', info);
  } catch (error) {
    console.error('Error al enviar el correo:', error);
    throw error;
  }
};

// Función principal exportada
exports.emailmx = async () => {
  try {
    const html = await generateEmailBody(); 
    await sendEmail(html);
    console.log("Correo Colombia enviado correctamente.");
  } catch (error) {
    console.error("Error al procesar el correo:", error);
    await sendErrorEmail(error);
    console.log("Correo de error enviado");
  }
};

// Al final del archivo:
if (require.main === module) {
  exports.emailmx();
}
