const spatialite = require('spatialite');
const fs = require('fs');

module.exports = function (RED) {
    function Spatialite(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        const configDbPath = config.dbPath;
        const configGeometryColumn = config.geometryColumn || 'geom';
        const configOutputGeometryFieldName = config.outputGeometryFieldName || 'geojson';
        const configStripHeader = config.stripHeader || true;
        const configSqlExcludingGeom = config.sqlExcludingGeom || "";

        function openDb(dbPath) {
            return new Promise((resolve, reject) => {
                if (!dbPath || !fs.existsSync(dbPath)) {
                    reject('Invalid database path ' + dbPath);
                    return;
                }
                const db = new spatialite.Database(dbPath, (err) => {
                    if (err) {
                        reject(err);
                        return;
                    }
                    resolve(db);
                });
            })
        }

        node.on('input', function (msg) {
            const dbPath = msg.dbPath || configDbPath;
            openDb(dbPath).then(db => {
                if (!db) {
                    node.send([null, {
                        msg: 'Unable to connect to database at ' + dbPath
                    }]);
                    return;
                }
                db.spatialite(function (error) {
                    if (error) {
                        node.send([null, {
                            msg: 'Error initialising spatialite ',
                            error
                        }]);
                        return;
                    }
                    let query = msg.sqlExcludingGeom || configSqlExcludingGeom;
                    const indexOf = query.indexOf(' ');
                    const geometryColumn = msg.geometryColumn || configGeometryColumn;
                    if (indexOf !== -1) {
                        query = `${query.slice(0, indexOf + 1)}${geometryColumn}, ${query.slice(indexOf + 1)}`;
                    }
                    if (!query) {
                        node.send([null, 'Invalid query ' + query]);
                    }

                    db.all(query, [], function (err, rows) {
                        if (err) {
                            node.send([null, {
                                msg: 'Error executing query ' + query,
                                error: err
                            }]);
                            return;
                        }
                        if (!rows) {
                            node.send({
                                msg: 'No results found for ' + query,
                            });
                            return;
                        }
                        const stripHeader = msg.stripHeader === false ? false : msg.stripHeader === true || configStripHeader;
                        const outputGeometryFieldName = msg.outputGeometryFieldName || configOutputGeometryFieldName;
                        getGeoJSonPromises(rows, stripHeader, geometryColumn, outputGeometryFieldName, db).then(geoJsons => {
                            rows.forEach((row, index) => {
                                row[outputGeometryFieldName] = geoJsons[index];
                            });
                            const payload = rows ? rows : 'No results found';
                            node.send({payload});
                            db.close();
                        });
                    });
                });
            }).catch(err => {
                node.send([null, {
                    msg: 'Unable to connect to database at ' + dbPath,
                    err
                }]);
            })
        });

        function getGeoJSonPromises(rows, stripHeader, geometryColumn, outputGeometryFieldName, db) {
            const promises = [];
            rows.forEach((row) => {
                const geometryHeaderHex = row[geometryColumn].toString('hex');
                const strippedGeometry = stripHeader ? stripHeaders(geometryHeaderHex) : geometryHeaderHex;
                const innerQuery = " SELECT asgeojson(GeomFromWKB(X'" + strippedGeometry + "')) as " + outputGeometryFieldName + ";";
                delete row[geometryColumn];
                promises.push(new Promise((resolve, reject) => {
                    db.all(innerQuery, [], (err, rows1) => {
                        if (err) {
                            reject(err);
                        }
                        resolve(JSON.parse(rows1[0][outputGeometryFieldName]));
                    });
                }));
            });
            return Promise.all(promises);
        }

        function stripHeaders(geometryHeaderHex) {
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
        }
    }

    RED.nodes.registerType("spatialite", Spatialite);
};