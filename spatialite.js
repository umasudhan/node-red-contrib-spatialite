const spatialite = require('spatialite');
const fs = require('fs');

module.exports = function(RED) {
    function Spatialite(config) {
        RED.nodes.createNode(this,config);
        const node = this;
        const dbPath = config.dbPath;
        const geometryColumn = config.geometryColumn || 'geom'; //todo default to geom in ui
        const outputGeometryFieldName = config.outputGeometryFieldName || 'geojson'; //todo default to geojson in ui
        const stripHeader = config.stripHeader || true; //todo default to true in ui
        const sqlExcludingGeom = config.sqlExcludingGeom || ""; //todo mandatory in ui- remove default here

        let db;
        if (dbPath && fs.existsSync(dbPath)) {
            db = new spatialite.Database(dbPath, (err) => {
                if (err) {
                    node.send([null, 'Error connecting to database at '+ dbPath+' '+err ]);
                }
                console.log('Connected to the geopackage database at ', dbPath);
            });
        }
        if (!db) {
            node.send([null, 'Unable to connect to database at '+ dbPath]);
        }
        let query = sqlExcludingGeom.toLowerCase();
        const indexOf = query.indexOf(' ');
        if (indexOf !== -1) {
            query = `${query.slice(0, indexOf + 1)}${geometryColumn}, ${query.slice(indexOf + 1)}`;
            console.log('query:',query);
        }
        if(!query){
            node.send([null, 'Invalid query '+ query]);
        }

        node.on('input', function(msg) {
            if(!db){
                node.send([null, {
                    msg: 'Unable to connect to database at '+ dbPath
                }]);
                return;
            }
            db.spatialite(function (error) {
                if(error){
                    node.send([null, {
                        msg: 'Error initialising spatialite ',
                        error
                    }]);
                    return;
                }
                db.all(query, [], function (err, rows) {
                    if(err){
                        node.send([null, {
                            msg: 'Error executing query '+ query,
                            error: err
                        }]);
                        return;
                    }
                    if(!rows){
                        node.send( {
                            msg: 'No results found for '+ query,
                        });
                        return;
                    }
                    getGeoJSonPromises(rows).then(function (geoJsons) {
                        rows.forEach((row, index)=>{
                            row[outputGeometryFieldName] = geoJsons[index];
                        });
                        node.send({payload:rows});
                    });
                });
            });
        });

        function getGeoJSonPromises(rows) {
            const promises = [];
            rows.forEach((row) => {
                const geometryHeaderHex = row[geometryColumn].toString('hex');
                const strippedGeometry = stripHeaders(geometryHeaderHex);
                const innerQuery = " SELECT asgeojson(GeomFromWKB(X'" + strippedGeometry + "')) as " + outputGeometryFieldName + ";";
                delete row[geometryColumn];
                promises.push(new Promise((resolve, reject) => {
                    db.all(innerQuery, [], function (err, rows1) {
                        if(err){
                            reject(err);
                        }
                        resolve(JSON.parse(rows1[0][outputGeometryFieldName]));
                    });
                }));
            });
            return Promise.all(promises);
        }

        function stripHeaders(geometryHeaderHex) {
            if(stripHeader){
                const envelopeSizeValues = [0, 32, 48, 48, 64];
                const flags = geometryHeaderHex.substring(6, 8);
                const binaryFlags = parseInt(flags.toString(), 16).toString(2); // see http://www.geopackage.org/spec/#flags_layout
                const maskedEnvelopeSizeBits = (binaryFlags & 1110) >>> 1;
                let envelopeSize;
                if (maskedEnvelopeSizeBits > 4) { //todo 5-7 are invalid according to the spec- just skip this? or default to 32?
                    envelopeSize = envelopeSizeValues[1]
                } else {
                    envelopeSize = envelopeSizeValues[maskedEnvelopeSizeBits]
                }
                const headerSizeInBytes = 2/*magic 4750*/ + 1/*version*/ + 1/*flags*/ + 4/*srs_id*/ + envelopeSize;
                return geometryHeaderHex.substring(2 * headerSizeInBytes);
            }else{
                return geometryHeaderHex;
            }
        }
    }
    RED.nodes.registerType("spatialite",Spatialite);
};