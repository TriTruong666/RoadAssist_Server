const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const schema = require('../src/schemas/place_flag.schema');
const Place = require('../src/services/place.service');
const { distanceMeters } = require('../src/utils/geo.util');
after(async () => { require('../src/config/redis.config').disconnect(); await require('../src/config/postgres.config').close(); });
test('route geometry requires finite GeoJSON longitude/latitude pairs and bounded stop count', () => {
 assert.equal(schema.point({latitude:91,longitude:0}),false);
 assert.equal(schema.point({latitude:0,longitude:NaN}),false);
 assert.equal(schema.geometry({type:'LineString',coordinates:[[106,10],[107,11]]}),true);
 for(const coordinates of [[[10,106],[11,107]],[[0,0]],[[0,0],[Infinity,0]],[[0,0,0],[1,1,1]]]) assert.equal(schema.geometry({type:'LineString',coordinates}),false);
 assert.equal(schema.geometry({type:'Polygon',coordinates:[[0,0],[1,1]]}),false);
});
test('hazard exclusion polygons are closed, spherical and correct near poles/date line', () => {
 for(const center of [{latitude:10.77,longitude:106.69},{latitude:89.9999,longitude:179.9999},{latitude:-89.9999,longitude:-179.9999}]) {
  const polygon=Place.ring({...center,radiusMeters:250});assert.equal(polygon.length,17);assert.deepEqual(polygon[0],polygon[16]);
  for(const [longitude,latitude] of polygon) {
   assert.ok(Math.abs(longitude)<=180&&Math.abs(latitude)<=90);
   assert.ok(Math.abs(distanceMeters(center,{longitude,latitude})-250)<0.01);
  }
 }
});
test('Phase 4 Swagger exposes twenty-one operations including authenticated binary map tiles', () => {
 const spec=require('../src/config/places_flags.swagger');
 const tile = spec.paths['/api/v1/places/tiles/{theme}/{z}/{x}/{y}.png'].get;
 assert.deepEqual(tile.security,[{cookieAuth:[]}]);
 assert.equal(tile.responses[200].content['image/png'].schema.format,'binary');
 assert.equal(Object.values(spec.paths).reduce((n,p)=>n+Object.keys(p).length,0),21);
 assert.deepEqual(spec.paths['/api/v1/flags/nearby'].get.security,[]);
 assert.deepEqual(spec.paths['/api/v1/flags'].post.security,[{cookieAuth:[]}]);
 assert.equal(spec.paths['/api/v1/flags'].post.requestBody.content['multipart/form-data'].schema.allOf[1].properties.images.maxItems,3);
 const full=require('../src/config/swagger.config');assert.ok(full.components.schemas.SavedRouteInput);assert.ok(full.paths['/api/v1/places/route']);
});
