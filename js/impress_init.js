$(document).ready(function(){
  impress().init();
  var slides = [];
  $("#pages").children("h1").each(function(index){
    var onepage = $(this).nextUntil("h1");
    var div = $("<div class='step'></div>");
    div.append(this).append(onepage);
    $("#impress").append(div);
  });
});